import { useState, useRef, useCallback, useEffect } from 'react';
import { WireFrame, MessageActivity } from '../types/telemetry';

const MAX_FRAMES_BUFFER = 100;
const MAX_ACTIVITIES_BUFFER = 100;
const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 10000;

export type SocketStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

/**
 * Extracts a human-readable message string from arbitrary payload structures.
 */
export function extractMessageContent(payload: unknown): string {
  if (payload === null || payload === undefined) {
    return '(empty payload)';
  }
  if (typeof payload === 'string') {
    return payload;
  }
  if (typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    if (typeof obj.content === 'string') return obj.content;
    if (typeof obj.message === 'string') return obj.message;
    if (typeof obj.text === 'string') return obj.text;
    if (obj.content !== undefined && typeof obj.content !== 'object') return String(obj.content);
    if (obj.message !== undefined && typeof obj.message !== 'object') return String(obj.message);
    if (obj.text !== undefined && typeof obj.text !== 'object') return String(obj.text);
    try {
      return JSON.stringify(payload);
    } catch {
      return String(payload);
    }
  }
  return String(payload);
}

export function usePulseSocket() {
  const [status, setStatus] = useState<SocketStatus>('disconnected');
  const [frames, setFrames] = useState<WireFrame[]>([]);
  const [activities, setActivities] = useState<MessageActivity[]>([]);
  const [subscribedRooms, setSubscribedRooms] = useState<string[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [isBursting, setIsBursting] = useState<boolean>(false);
  const [burstProgress, setBurstProgress] = useState<{ sent: number; total: number } | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const frameIdCounter = useRef<number>(0);
  const activityIdCounter = useRef<number>(0);
  const shouldConnectRef = useRef<boolean>(false);
  const intentionalDisconnectRef = useRef<boolean>(false);
  const activeUrlRef = useRef<string>('');
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef<number>(0);
  const subscribedRoomsRef = useRef<string[]>([]);

  // Keep ref in sync with state
  useEffect(() => {
    subscribedRoomsRef.current = subscribedRooms;
  }, [subscribedRooms]);

  const addFrame = useCallback((direction: 'inbound' | 'outbound', data: unknown) => {
    const id = `frm-${Date.now()}-${++frameIdCounter.current}`;
    let raw = '';
    let parsed: Record<string, unknown> = {};
    let type = 'UNKNOWN';
    let room: string | undefined;
    let action: string | undefined;

    if (typeof data === 'string') {
      raw = data;
      try {
        parsed = JSON.parse(data);
        type = (parsed.type as string) || (parsed.action as string) || 'MESSAGE';
        const targetObj = parsed.target as Record<string, unknown> | undefined;
        room = (parsed.room as string | undefined) || (targetObj?.roomId as string | undefined);
        action = parsed.action as string | undefined;
      } catch {
        parsed = { raw: data };
      }
    } else if (typeof data === 'object' && data !== null) {
      parsed = data as Record<string, unknown>;
      raw = JSON.stringify(data);
      type = (parsed.type as string) || (parsed.action as string) || 'MESSAGE';
      const targetObj = parsed.target as Record<string, unknown> | undefined;
      room = (parsed.room as string | undefined) || (targetObj?.roomId as string | undefined);
      action = parsed.action as string | undefined;
    }

    const frame: WireFrame = {
      id,
      timestamp: new Date().toISOString().split('T')[1].slice(0, 12),
      direction,
      type,
      action,
      room,
      payload: parsed,
      raw,
      sizeBytes: typeof Blob !== 'undefined' ? new Blob([raw]).size : raw.length
    };

    setFrames((prev) => {
      const updated = [frame, ...prev];
      if (updated.length > MAX_FRAMES_BUFFER) {
        return updated.slice(0, MAX_FRAMES_BUFFER);
      }
      return updated;
    });
  }, []);

  const cleanupSocket = useCallback(() => {
    if (socketRef.current) {
      const ws = socketRef.current;
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'Cleaning up socket');
      }
      socketRef.current = null;
    }
  }, []);

  const doConnect = useCallback((url: string, isReconnecting: boolean) => {
    // If a socket is already open or connecting to the same URL and not reconnecting, don't create duplicate
    if (
      socketRef.current &&
      (socketRef.current.readyState === WebSocket.OPEN || socketRef.current.readyState === WebSocket.CONNECTING) &&
      activeUrlRef.current === url &&
      !isReconnecting
    ) {
      return;
    }

    cleanupSocket();

    try {
      setStatus(isReconnecting ? 'reconnecting' : 'connecting');
      setLastError(null);

      const ws = new WebSocket(url);
      socketRef.current = ws;

      ws.onopen = () => {
        if (socketRef.current !== ws) return;
        setStatus('connected');
        setLastError(null);
        reconnectAttemptsRef.current = 0;

        // Resubscribe to existing desired rooms upon connection/reconnection
        if (subscribedRoomsRef.current.length > 0) {
          subscribedRoomsRef.current.forEach((room) => {
            const subMessage = {
              type: 'ROOM_JOIN',
              target: { roomId: room },
              payload: { roomId: room }
            };
            const subStr = JSON.stringify(subMessage);
            ws.send(subStr);
            addFrame('outbound', subStr);
          });
        }
      };

      ws.onmessage = (event) => {
        if (socketRef.current !== ws) return;
        addFrame('inbound', event.data);

        try {
          const rawStr = typeof event.data === 'string' ? event.data : '';
          if (rawStr) {
            const parsed = JSON.parse(rawStr);
            if (parsed && typeof parsed === 'object') {
              const eventType = parsed.type as string;

              // Detect incoming SYS_PING and immediately reply with canonical SYS_PONG
              if (eventType === 'SYS_PING') {
                const pongEnvelope = {
                  type: 'SYS_PONG',
                  correlationId: (parsed.eventId as string) || (parsed.correlationId as string) || undefined,
                  timestamp: Date.now(),
                  payload: {}
                };
                const pongStr = JSON.stringify(pongEnvelope);
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(pongStr);
                  addFrame('outbound', pongStr);
                }
              }

              // Inbound ROOM_MESSAGE: Record received activity
              else if (eventType === 'ROOM_MESSAGE') {
                const targetObj = parsed.target as Record<string, unknown> | undefined;
                const roomId = (targetObj?.roomId as string) || (parsed.room as string) || 'lobby';
                const senderId = (parsed.senderId as string) || undefined;
                const content = extractMessageContent(parsed.payload);
                const timeStr = new Date().toTimeString().split(' ')[0];

                const activity: MessageActivity = {
                  id: `act-in-${Date.now()}-${++activityIdCounter.current}`,
                  correlationId: (parsed.correlationId as string) || undefined,
                  direction: 'received',
                  roomId,
                  senderId,
                  content,
                  timestamp: timeStr,
                  timestampMs: Date.now(),
                  status: 'delivered',
                  rawPayload: typeof parsed.payload === 'object' && parsed.payload !== null
                    ? parsed.payload as Record<string, unknown>
                    : { content }
                };

                setActivities((prev) => {
                  const next = [...prev, activity];
                  if (next.length > MAX_ACTIVITIES_BUFFER) {
                    return next.slice(next.length - MAX_ACTIVITIES_BUFFER);
                  }
                  return next;
                });
              }

              // Inbound DELIVERY_ACK: Reconcile pending sent message
              else if (eventType === 'DELIVERY_ACK') {
                const correlationId = (parsed.correlationId as string) || (parsed.payload?.targetEventId as string);
                if (correlationId) {
                  const timeStr = new Date().toTimeString().split(' ')[0];
                  setActivities((prev) => {
                    let matched = false;
                    const next = prev.map((act) => {
                      if (act.direction === 'sent' && act.status === 'pending') {
                        if (act.correlationId === correlationId || act.id === correlationId) {
                          matched = true;
                          return {
                            ...act,
                            status: 'delivered' as const,
                            ackReceivedAt: timeStr
                          };
                        }
                      }
                      return act;
                    });
                    return matched ? next : prev;
                  });
                }
              }

              // Inbound SYS_ERROR: Check if associated with pending sent message
              else if (eventType === 'SYS_ERROR') {
                const correlationId = (parsed.correlationId as string) || (parsed.payload?.targetEventId as string);
                if (correlationId) {
                  setActivities((prev) => {
                    let matched = false;
                    const next = prev.map((act) => {
                      if (act.direction === 'sent' && act.status === 'pending') {
                        if (act.correlationId === correlationId || act.id === correlationId) {
                          matched = true;
                          return {
                            ...act,
                            status: 'failed' as const
                          };
                        }
                      }
                      return act;
                    });
                    return matched ? next : prev;
                  });
                }
              }
            }
          }
        } catch {
          // Frame is not JSON or unexpected format; ignore
        }
      };

      ws.onerror = () => {
        if (socketRef.current !== ws) return;
        setStatus('error');
        setLastError('WebSocket transport error encountered');
      };

      ws.onclose = (event) => {
        if (socketRef.current !== ws) return;
        socketRef.current = null;

        // If closed intentionally by user, stay disconnected
        if (intentionalDisconnectRef.current || !shouldConnectRef.current) {
          setStatus('disconnected');
          return;
        }

        if (!event.wasClean) {
          if (event.code === 1006) {
            setLastError('Connection closed abnormally (code 1006) — Handshake rejected by server (check auth token or port)');
          } else {
            setLastError(`Connection closed abnormally (code ${event.code})`);
          }
        }

        // Trigger controlled reconnect with bounded backoff
        scheduleReconnect();
      };
    } catch (err: unknown) {
      setStatus('error');
      setLastError(err instanceof Error ? err.message : String(err));
      if (shouldConnectRef.current && !intentionalDisconnectRef.current) {
        scheduleReconnect();
      }
    }
  }, [cleanupSocket, addFrame]);

  const scheduleReconnect = useCallback(() => {
    if (!shouldConnectRef.current || intentionalDisconnectRef.current) {
      return;
    }

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    const attempts = reconnectAttemptsRef.current;
    if (attempts >= MAX_RECONNECT_ATTEMPTS) {
      setStatus('disconnected');
      setLastError(`Reconnection failed after ${MAX_RECONNECT_ATTEMPTS} attempts. Click Connect to retry.`);
      shouldConnectRef.current = false;
      return;
    }

    setStatus('reconnecting');
    reconnectAttemptsRef.current = attempts + 1;

    // Bounded exponential backoff: base 1000ms, factor 1.5, max 10000ms, plus up to 500ms random jitter
    const expDelay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(1.5, attempts));
    const jitter = Math.floor(Math.random() * 500);
    const delay = Math.min(MAX_BACKOFF_MS, expDelay + jitter);

    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      if (shouldConnectRef.current && !intentionalDisconnectRef.current && activeUrlRef.current) {
        doConnect(activeUrlRef.current, true);
      }
    }, delay);
  }, [doConnect]);

  const connect = useCallback((url: string) => {
    shouldConnectRef.current = true;
    intentionalDisconnectRef.current = false;
    activeUrlRef.current = url;
    reconnectAttemptsRef.current = 0;

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    doConnect(url, false);
  }, [doConnect]);

  const disconnect = useCallback(() => {
    shouldConnectRef.current = false;
    intentionalDisconnectRef.current = true;
    reconnectAttemptsRef.current = 0;

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    cleanupSocket();
    setStatus('disconnected');
  }, [cleanupSocket]);

  const sendRaw = useCallback((message: string | object) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      setLastError('Cannot send: Socket is not open');
      return false;
    }

    const str = typeof message === 'string' ? message : JSON.stringify(message);
    socketRef.current.send(str);
    addFrame('outbound', str);

    // Track sent message activity for ROOM_MESSAGE and DIRECT_MESSAGE
    try {
      let parsedObj: Record<string, unknown> | null = null;
      if (typeof message === 'object' && message !== null) {
        parsedObj = message as Record<string, unknown>;
      } else if (typeof message === 'string') {
        parsedObj = JSON.parse(message);
      }

      if (parsedObj && (parsedObj.type === 'ROOM_MESSAGE' || parsedObj.type === 'DIRECT_MESSAGE')) {
        const targetObj = parsedObj.target as Record<string, unknown> | undefined;
        const roomId = (targetObj?.roomId as string) || (parsedObj.room as string) || 'lobby';
        const correlationId = (parsedObj.correlationId as string) || undefined;
        const content = extractMessageContent(parsedObj.payload);
        const timeStr = new Date().toTimeString().split(' ')[0];

        const activity: MessageActivity = {
          id: `act-out-${Date.now()}-${++activityIdCounter.current}`,
          correlationId,
          direction: 'sent',
          roomId,
          senderId: (parsedObj.senderId as string) || undefined,
          content,
          timestamp: timeStr,
          timestampMs: Date.now(),
          status: 'pending',
          rawPayload: typeof parsedObj.payload === 'object' && parsedObj.payload !== null
            ? parsedObj.payload as Record<string, unknown>
            : { content }
        };

        setActivities((prev) => {
          const next = [...prev, activity];
          if (next.length > MAX_ACTIVITIES_BUFFER) {
            return next.slice(next.length - MAX_ACTIVITIES_BUFFER);
          }
          return next;
        });
      }
    } catch {
      // ignore parsing error
    }

    return true;
  }, [addFrame]);

  const subscribe = useCallback((room: string) => {
    const frame = {
      type: 'ROOM_JOIN',
      target: { roomId: room },
      payload: { roomId: room }
    };
    if (sendRaw(frame)) {
      setSubscribedRooms((prev) => {
        const next = Array.from(new Set([...prev, room]));
        subscribedRoomsRef.current = next;
        return next;
      });
    }
  }, [sendRaw]);

  const unsubscribe = useCallback((room: string) => {
    const frame = {
      type: 'ROOM_LEAVE',
      target: { roomId: room },
      payload: { roomId: room }
    };
    if (sendRaw(frame)) {
      setSubscribedRooms((prev) => {
        const next = prev.filter((r) => r !== room);
        subscribedRoomsRef.current = next;
        return next;
      });
    }
  }, [sendRaw]);

  const clearFrames = useCallback(() => {
    setFrames([]);
  }, []);

  const clearActivities = useCallback(() => {
    setActivities([]);
  }, []);

  // Handle browser visibility changes
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (typeof document === 'undefined') return;

      if (document.visibilityState === 'visible') {
        if (!shouldConnectRef.current || intentionalDisconnectRef.current) {
          return;
        }

        const ws = socketRef.current;
        // If already connected or actively connecting, do not duplicate
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
          return;
        }

        // Socket dropped while hidden, reconnect immediately
        if (activeUrlRef.current) {
          if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
          }
          doConnect(activeUrlRef.current, true);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [doConnect]);

  // Cleanup on hook unmount
  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      cleanupSocket();
    };
  }, [cleanupSocket]);

  // 1-Click Load Generator: Send 500 frames in micro-batches
  const triggerBurstLoad = useCallback(async (room: string = 'load-test', count: number = 500) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      setLastError('Connect to server before running load generator');
      return;
    }

    setIsBursting(true);
    setBurstProgress({ sent: 0, total: count });

    const batchSize = 25;
    let sentCount = 0;

    const sendBatch = () => {
      if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
        setIsBursting(false);
        setBurstProgress(null);
        return;
      }

      const currentBatch = Math.min(batchSize, count - sentCount);
      for (let i = 0; i < currentBatch; i++) {
        const envelope = {
          type: 'ROOM_MESSAGE',
          target: { roomId: room },
          payload: {
            content: `Load generator burst frame ${sentCount + i + 1}`,
            seq: sentCount + i + 1,
            client: 'load-generator',
            entropy: Math.random().toString(36).substring(2, 10)
          },
          timestamp: Date.now()
        };
        const str = JSON.stringify(envelope);
        socketRef.current.send(str);
        addFrame('outbound', str);
      }

      sentCount += currentBatch;
      setBurstProgress({ sent: sentCount, total: count });

      if (sentCount < count) {
        setTimeout(sendBatch, 16); // ~60fps micro-batch cadence
      } else {
        setIsBursting(false);
        setBurstProgress(null);
      }
    };

    sendBatch();
  }, [addFrame]);

  return {
    status,
    frames,
    activities,
    clearActivities,
    subscribedRooms,
    lastError,
    connect,
    disconnect,
    sendRaw,
    subscribe,
    unsubscribe,
    clearFrames,
    triggerBurstLoad,
    isBursting,
    burstProgress
  };
}
