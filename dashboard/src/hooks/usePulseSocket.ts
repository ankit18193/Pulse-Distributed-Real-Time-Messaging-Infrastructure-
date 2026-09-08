import { useState, useRef, useCallback, useEffect } from 'react';
import { WireFrame } from '../types/telemetry';

const MAX_FRAMES_BUFFER = 100;

export type SocketStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export function usePulseSocket() {
  const [status, setStatus] = useState<SocketStatus>('disconnected');
  const [frames, setFrames] = useState<WireFrame[]>([]);
  const [subscribedRooms, setSubscribedRooms] = useState<string[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [isBursting, setIsBursting] = useState<boolean>(false);
  const [burstProgress, setBurstProgress] = useState<{ sent: number; total: number } | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const frameIdCounter = useRef<number>(0);

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
        room = parsed.room as string | undefined;
        action = parsed.action as string | undefined;
      } catch {
        parsed = { raw: data };
      }
    } else if (typeof data === 'object' && data !== null) {
      parsed = data as Record<string, unknown>;
      raw = JSON.stringify(data);
      type = (parsed.type as string) || (parsed.action as string) || 'MESSAGE';
      room = parsed.room as string | undefined;
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
      sizeBytes: new Blob([raw]).size
    };

    setFrames((prev) => {
      const updated = [frame, ...prev];
      if (updated.length > MAX_FRAMES_BUFFER) {
        return updated.slice(0, MAX_FRAMES_BUFFER);
      }
      return updated;
    });
  }, []);

  const connect = useCallback((url: string) => {
    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }

    try {
      setStatus('connecting');
      setLastError(null);

      const ws = new WebSocket(url);
      socketRef.current = ws;

      ws.onopen = () => {
        setStatus('connected');
        setLastError(null);
      };

      ws.onmessage = (event) => {
        addFrame('inbound', event.data);
      };

      ws.onerror = () => {
        setStatus('error');
        setLastError('WebSocket transport error encountered');
      };

      ws.onclose = (event) => {
        setStatus('disconnected');
        socketRef.current = null;
        if (!event.wasClean) {
          setLastError(`Connection closed abnormally (code ${event.code})`);
        }
      };
    } catch (err: unknown) {
      setStatus('error');
      setLastError(err instanceof Error ? err.message : String(err));
    }
  }, [addFrame]);

  const disconnect = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }
    setStatus('disconnected');
  }, []);

  const sendRaw = useCallback((message: string | object) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      setLastError('Cannot send: Socket is not open');
      return false;
    }

    const str = typeof message === 'string' ? message : JSON.stringify(message);
    socketRef.current.send(str);
    addFrame('outbound', str);
    return true;
  }, [addFrame]);

  const subscribe = useCallback((room: string) => {
    if (sendRaw({ type: 'SUBSCRIBE', room })) {
      setSubscribedRooms((prev) => Array.from(new Set([...prev, room])));
    }
  }, [sendRaw]);

  const unsubscribe = useCallback((room: string) => {
    if (sendRaw({ type: 'UNSUBSCRIBE', room })) {
      setSubscribedRooms((prev) => prev.filter((r) => r !== room));
    }
  }, [sendRaw]);

  const clearFrames = useCallback(() => {
    setFrames([]);
  }, []);

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
        const payload = {
          type: 'BROADCAST',
          room,
          seq: sentCount + i + 1,
          ts: Date.now(),
          client: 'load-generator',
          entropy: Math.random().toString(36).substring(2, 10)
        };
        const str = JSON.stringify(payload);
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

  useEffect(() => {
    return () => {
      if (socketRef.current) {
        socketRef.current.close();
      }
    };
  }, []);

  return {
    status,
    frames,
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
