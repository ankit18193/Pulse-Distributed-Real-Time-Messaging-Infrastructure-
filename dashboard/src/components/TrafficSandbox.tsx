import React, { useState, useEffect, useRef } from 'react';
import { usePulseSocket } from '../hooks/usePulseSocket';
import { WireFrame, MessageActivity } from '../types/telemetry';
import {
  Terminal,
  Zap,
  Send,
  PlusCircle,
  MinusCircle,
  Copy,
  Check,
  Trash2,
  ArrowDownLeft,
  ArrowUpRight,
  Radio,
  Server,
  RefreshCw,
  Activity,
  ArrowDown,
  XCircle
} from 'lucide-react';

interface FrameItemProps {
  frame: WireFrame;
}

const FrameItem: React.FC<FrameItemProps> = ({ frame }) => {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const copyPayload = () => {
    navigator.clipboard.writeText(frame.raw);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const isInbound = frame.direction === 'inbound';

  return (
    <div style={{
      background: 'var(--pulse-bg-surface)',
      border: '1px solid var(--pulse-border-subtle)',
      borderRadius: '6px',
      padding: '8px 10px',
      marginBottom: '6px',
      fontFamily: 'var(--font-mono)',
      fontSize: '11px'
    }}>
      {/* Frame Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {isInbound ? (
            <span className="badge badge-cyan" style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
              <ArrowDownLeft size={11} /> IN
            </span>
          ) : (
            <span className="badge badge-emerald" style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
              <ArrowUpRight size={11} /> OUT
            </span>
          )}

          <span className="badge badge-violet" style={{ fontSize: '10px' }}>
            {frame.type}
          </span>

          {frame.room && (
            <span className="badge badge-muted" style={{ fontSize: '10px' }}>
              room:{frame.room}
            </span>
          )}

          <span style={{ color: 'var(--pulse-text-muted)' }}>
            {frame.timestamp}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ color: 'var(--pulse-text-muted)', fontSize: '10px' }}>
            {frame.sizeBytes} B
          </span>
          <button
            onClick={copyPayload}
            title="Copy Raw Wire JSON"
            className="btn-secondary"
            style={{ padding: '2px 6px', fontSize: '10px' }}
          >
            {copied ? <Check size={11} color="var(--pulse-accent-emerald)" /> : <Copy size={11} />}
          </button>
          <button
            onClick={() => setExpanded((p) => !p)}
            className="btn-secondary"
            style={{ padding: '2px 6px', fontSize: '10px' }}
          >
            {expanded ? 'Fold' : 'Inspect'}
          </button>
        </div>
      </div>

      {/* Frame Content */}
      <div style={{ marginTop: '6px', color: 'var(--pulse-text-primary)', wordBreak: 'break-all' }}>
        {expanded ? (
          <pre style={{
            background: 'var(--pulse-bg-sunken)',
            padding: '6px 8px',
            borderRadius: '4px',
            overflowX: 'auto',
            maxHeight: '150px',
            color: 'var(--pulse-accent-cyan)'
          }}>
            {JSON.stringify(frame.payload, null, 2)}
          </pre>
        ) : (
          <div style={{
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            color: 'var(--pulse-text-secondary)'
          }}>
            {frame.raw}
          </div>
        )}
      </div>
    </div>
  );
};

interface MessageActivityItemProps {
  activity: MessageActivity;
}

const MessageActivityItem: React.FC<MessageActivityItemProps> = ({ activity }) => {
  const [expanded, setExpanded] = useState(false);
  const isSent = activity.direction === 'sent';
  const isLong = activity.content.length > 350;
  const displayContent = isLong && !expanded
    ? `${activity.content.slice(0, 300)}... [truncated, ${activity.content.length} chars total]`
    : activity.content;

  return (
    <div style={{
      background: 'var(--pulse-bg-surface)',
      border: '1px solid var(--pulse-border-subtle)',
      borderLeft: isSent
        ? '3px solid var(--pulse-accent-emerald)'
        : '3px solid var(--pulse-accent-cyan)',
      borderRadius: '6px',
      padding: '8px 12px',
      marginBottom: '8px',
      fontFamily: 'var(--font-sans)',
      fontSize: '12px'
    }}>
      {/* Activity Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
        marginBottom: '6px',
        flexWrap: 'wrap'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {isSent ? (
            <span className="badge badge-emerald" style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
              <ArrowUpRight size={11} /> SENT
            </span>
          ) : (
            <span className="badge badge-cyan" style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
              <ArrowDownLeft size={11} /> RECEIVED
            </span>
          )}

          <span className="badge badge-muted" style={{ fontSize: '10px' }}>
            #{activity.roomId}
          </span>

          {!isSent && activity.senderId && activity.senderId !== 'unknown' && (
            <span className="badge badge-violet" style={{ fontSize: '10px' }}>
              from: {activity.senderId}
            </span>
          )}

          {isSent && (
            activity.status === 'delivered' ? (
              <span
                className="badge badge-emerald"
                style={{ fontSize: '10px' }}
                title={activity.ackReceivedAt ? `DELIVERY_ACK received at ${activity.ackReceivedAt}` : 'DELIVERY_ACK confirmed'}
              >
                <Check size={10} /> DELIVERED
              </span>
            ) : activity.status === 'failed' ? (
              <span className="badge badge-crimson" style={{ fontSize: '10px' }}>
                <XCircle size={10} /> REJECTED
              </span>
            ) : (
              <span className="badge badge-amber" style={{ fontSize: '10px' }} title="Awaiting server DELIVERY_ACK">
                <RefreshCw size={9} className="spin" /> PENDING ACK
              </span>
            )
          )}
        </div>

        <span style={{ color: 'var(--pulse-text-muted)', fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
          {activity.timestamp}
        </span>
      </div>

      {/* Message Content */}
      <div style={{
        color: 'var(--pulse-text-primary)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        overflowWrap: 'anywhere',
        lineHeight: 1.45
      }}>
        {displayContent}
      </div>

      {/* Truncation toggle */}
      {isLong && (
        <div style={{ marginTop: '4px' }}>
          <button
            onClick={() => setExpanded((p) => !p)}
            className="btn-secondary"
            style={{ padding: '2px 6px', fontSize: '10px' }}
          >
            {expanded ? 'Show Less' : `Show Full (${activity.content.length} chars)`}
          </button>
        </div>
      )}
    </div>
  );
};

const SANDBOX_SESSION_KEY = 'pulse_sandbox_session';

export const TrafficSandbox: React.FC = () => {
  const {
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
  } = usePulseSocket();

  // Dynamic default WS URL based on current host and backend port
  const defaultWsUrl = (import.meta.env.VITE_WS_URL as string) || (typeof window !== 'undefined'
    ? (() => {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const port = window.location.port;
        const hostPort = port === '5173'
          ? `${window.location.hostname}:8085`
          : (port && port !== '80' && port !== '443')
            ? `${window.location.hostname}:${port}`
            : window.location.hostname;
        return `${proto}//${hostPort}/ws`;
      })()
    : 'ws://127.0.0.1:8085/ws');
  const [serverUrl, setServerUrl] = useState(defaultWsUrl);
  const [authToken, setAuthToken] = useState('');
  const [roomInput, setRoomInput] = useState('lobby');
  const [msgPayload, setMsgPayload] = useState('{"content": "Hello from Mission Control"}');
  const [directionFilter, setDirectionFilter] = useState<'all' | 'inbound' | 'outbound'>('all');
  const [resumedNotice, setResumedNotice] = useState<string | null>(null);

  // Message Activity auto-scroll & scroll-lock state
  const activityListRef = useRef<HTMLDivElement>(null);
  const isActivityScrolledUpRef = useRef<boolean>(false);
  const [hasNewActivities, setHasNewActivities] = useState<boolean>(false);

  const handleActivityScroll = () => {
    if (!activityListRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = activityListRef.current;
    const distanceFromBottom = scrollHeight - (scrollTop + clientHeight);
    const isUp = distanceFromBottom > 35;
    isActivityScrolledUpRef.current = isUp;
    if (!isUp) {
      setHasNewActivities(false);
    }
  };

  useEffect(() => {
    if (!activityListRef.current) return;
    if (!isActivityScrolledUpRef.current) {
      activityListRef.current.scrollTop = activityListRef.current.scrollHeight;
    } else {
      setHasNewActivities(true);
    }
  }, [activities]);

  const scrollToNewestActivity = () => {
    if (activityListRef.current) {
      activityListRef.current.scrollTo({
        top: activityListRef.current.scrollHeight,
        behavior: 'smooth'
      });
      setHasNewActivities(false);
      isActivityScrolledUpRef.current = false;
    }
  };

  const isConnected = status === 'connected';

  // State refs for unmount lifecycle persistence
  const statusRef = useRef(status);
  statusRef.current = status;
  const serverUrlRef = useRef(serverUrl);
  serverUrlRef.current = serverUrl;
  const authTokenRef = useRef(authToken);
  authTokenRef.current = authToken;
  const roomInputRef = useRef(roomInput);
  roomInputRef.current = roomInput;

  // On mount: check if returning from dashboard tab switch with active session
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(SANDBOX_SESSION_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.autoResume && parsed.serverUrl) {
          if (parsed.serverUrl) setServerUrl(parsed.serverUrl);
          if (parsed.authToken) setAuthToken(parsed.authToken);
          if (parsed.roomInput) setRoomInput(parsed.roomInput);

          let finalUrl = parsed.serverUrl;
          if (parsed.authToken && parsed.authToken.trim() && !finalUrl.includes('token=')) {
            finalUrl += (finalUrl.includes('?') ? '&' : '?') + `token=${encodeURIComponent(parsed.authToken.trim())}`;
          }
          connect(finalUrl);
          setResumedNotice(`Resumed sandbox session for ${parsed.serverUrl}`);
          const timer = setTimeout(() => setResumedNotice(null), 4000);
          return () => clearTimeout(timer);
        }
      }
    } catch {
      // ignore storage parsing error
    }
  }, [connect]);

  // On unmount: explicitly record session state if user was connected/connecting
  useEffect(() => {
    return () => {
      if (
        statusRef.current === 'connected' ||
        statusRef.current === 'connecting' ||
        statusRef.current === 'reconnecting'
      ) {
        try {
          sessionStorage.setItem(
            SANDBOX_SESSION_KEY,
            JSON.stringify({
              autoResume: true,
              serverUrl: serverUrlRef.current,
              authToken: authTokenRef.current,
              roomInput: roomInputRef.current
            })
          );
        } catch {
          // ignore storage error
        }
      }
    };
  }, []);

  const handleConnectToggle = () => {
    if (isConnected || status === 'connecting' || status === 'reconnecting') {
      try {
        sessionStorage.removeItem(SANDBOX_SESSION_KEY);
      } catch {
        // ignore storage error
      }
      setResumedNotice(null);
      disconnect();
    } else {
      let finalUrl = serverUrl;
      if (authToken.trim() && !finalUrl.includes('token=')) {
        finalUrl += (finalUrl.includes('?') ? '&' : '?') + `token=${encodeURIComponent(authToken.trim())}`;
      }
      connect(finalUrl);
    }
  };

  const handleBroadcast = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isConnected) return;

    const trimmedRoom = roomInput.trim() || 'lobby';
    let frameToSend: Record<string, unknown>;

    try {
      const parsed = JSON.parse(msgPayload);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const candidateType = parsed.type;
        if (candidateType === 'ROOM_MESSAGE' || candidateType === 'DIRECT_MESSAGE') {
          // Canonical Pulse envelope provided directly
          frameToSend = {
            ...parsed,
            target: parsed.target && typeof parsed.target === 'object'
              ? parsed.target
              : { roomId: trimmedRoom },
            timestamp: parsed.timestamp || Date.now(),
            correlationId: parsed.correlationId || `corr-${Date.now()}`,
            ackRequired: parsed.ackRequired ?? true
          };
        } else if (candidateType === 'MESSAGE_SEND' || candidateType === 'BROADCAST') {
          // Normalize legacy/accidental action types to canonical ROOM_MESSAGE
          const payloadData = parsed.payload !== undefined
            ? parsed.payload
            : parsed.data !== undefined
              ? parsed.data
              : parsed;
          frameToSend = {
            type: 'ROOM_MESSAGE',
            target: {
              roomId: (parsed.target as any)?.roomId || parsed.room || trimmedRoom
            },
            payload: typeof payloadData === 'object' && payloadData !== null
              ? payloadData
              : { content: String(payloadData) },
            timestamp: Date.now(),
            correlationId: parsed.correlationId || `corr-${Date.now()}`,
            ackRequired: true
          };
        } else {
          // Valid JSON object represents the message payload
          frameToSend = {
            type: 'ROOM_MESSAGE',
            target: { roomId: trimmedRoom },
            payload: parsed,
            timestamp: Date.now(),
            correlationId: `corr-${Date.now()}`,
            ackRequired: true
          };
        }
      } else {
        // Primitive parsed JSON (number, boolean, etc.)
        frameToSend = {
          type: 'ROOM_MESSAGE',
          target: { roomId: trimmedRoom },
          payload: { content: parsed },
          timestamp: Date.now(),
          correlationId: `corr-${Date.now()}`,
          ackRequired: true
        };
      }
    } catch {
      // Raw string payload (non-JSON text in textarea)
      frameToSend = {
        type: 'ROOM_MESSAGE',
        target: { roomId: trimmedRoom },
        payload: { content: msgPayload },
        timestamp: Date.now(),
        correlationId: `corr-${Date.now()}`,
        ackRequired: true
      };
    }

    sendRaw(frameToSend);
  };

  const filteredFrames = frames.filter((f) => {
    if (directionFilter === 'all') return true;
    return f.direction === directionFilter;
  });

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(340px, 420px) 1fr', gap: '16px', paddingBottom: '32px' }}>
      {/* Left Column: Interactive Dispatch & Load Controls */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {/* Connection Setup Card */}
        <div className="telemetry-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Server size={16} color="var(--pulse-accent-cyan)" />
              <span style={{ fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', color: 'var(--pulse-text-primary)' }}>
                Target WebSocket Host
              </span>
            </div>
            <span className={`badge ${
              isConnected
                ? 'badge-emerald'
                : status === 'connecting' || status === 'reconnecting'
                ? 'badge-amber'
                : 'badge-crimson'
            }`}>
              {isConnected
                ? '[● CONNECTED]'
                : status === 'connecting'
                ? '[▲ CONNECTING]'
                : status === 'reconnecting'
                ? '[↻ RECONNECTING]'
                : '[✖ DISCONNECTED]'}
            </span>
          </div>

          {resumedNotice && (
            <div style={{
              fontSize: '11px',
              fontFamily: 'var(--font-mono)',
              color: 'var(--pulse-accent-cyan)',
              background: 'rgba(6, 182, 212, 0.1)',
              padding: '6px 8px',
              borderRadius: '4px',
              border: '1px solid rgba(6, 182, 212, 0.25)',
              marginBottom: '10px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}>
              <RefreshCw size={12} className="spin" />
              <span>{resumedNotice}</span>
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
            <input
              type="text"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              disabled={isConnected || status === 'connecting' || status === 'reconnecting'}
              style={{ flex: 1, fontSize: '12px' }}
              placeholder="ws://127.0.0.1:8085/ws"
            />
            <button
              onClick={handleConnectToggle}
              className={isConnected || status === 'connecting' || status === 'reconnecting' ? 'btn-danger' : 'btn-primary'}
              style={{ fontSize: '12px', padding: '6px 12px' }}
            >
              {isConnected
                ? 'Disconnect'
                : status === 'connecting'
                ? 'Connecting...'
                : status === 'reconnecting'
                ? 'Cancel'
                : 'Connect'}
            </button>
          </div>

          <div style={{ marginBottom: lastError ? '10px' : '0' }}>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <input
                type="text"
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                disabled={isConnected}
                style={{ flex: 1, fontSize: '11px', fontFamily: 'var(--font-mono)' }}
                placeholder="HMAC Auth Token (e.g. eyJ...)"
              />
              {import.meta.env.DEV && !isConnected && (
                <button
                  type="button"
                  onClick={() => setAuthToken('eyJ1c2VySWQiOiJtaXNzaW9uX2NvbnRyb2xfYWRtaW4iLCJyb2xlcyI6WyJhZG1pbiIsInVzZXIiXSwiaWF0IjoxNzg5MDQwMzk4NjI1LCJleHAiOjE3ODk5MDQzOTg2MjV9.AhCRgrOjSUjLuG-szVinfrF51788-U8KV_tP1dt6dhM')}
                  className="btn-secondary"
                  style={{ fontSize: '10px', padding: '5px 8px', whiteSpace: 'nowrap' }}
                  title="Populate valid local dev auth token signed with AUTH_SECRET"
                >
                  Fill Dev Token
                </button>
              )}
            </div>
          </div>

          {lastError && (
            <div style={{
              fontSize: '11px',
              fontFamily: 'var(--font-mono)',
              color: 'var(--pulse-accent-crimson)',
              background: 'rgba(239, 68, 68, 0.1)',
              padding: '6px 8px',
              borderRadius: '4px',
              border: '1px solid rgba(239, 68, 68, 0.25)'
            }}>
              {lastError}
            </div>
          )}
        </div>

        {/* Room Subscription Manager */}
        <div className="telemetry-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
            <Radio size={16} color="var(--pulse-accent-violet)" />
            <span style={{ fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', color: 'var(--pulse-text-primary)' }}>
              Room Subscriptions
            </span>
          </div>

          <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
            <input
              type="text"
              value={roomInput}
              onChange={(e) => setRoomInput(e.target.value)}
              placeholder="Room ID (e.g. lobby, alerts)"
              style={{ flex: 1, fontSize: '12px' }}
            />
            <button
              onClick={() => subscribe(roomInput)}
              disabled={!isConnected || !roomInput}
              className="btn-primary"
              style={{ fontSize: '12px', padding: '6px 10px' }}
              title="Subscribe to room"
            >
              <PlusCircle size={14} /> Join
            </button>
            <button
              onClick={() => unsubscribe(roomInput)}
              disabled={!isConnected || !roomInput}
              className="btn-secondary"
              style={{ fontSize: '12px', padding: '6px 10px' }}
              title="Unsubscribe from room"
            >
              <MinusCircle size={14} /> Leave
            </button>
          </div>

          <div>
            <span style={{ fontSize: '11px', color: 'var(--pulse-text-muted)' }}>Active in: </span>
            {subscribedRooms.length === 0 ? (
              <span style={{ fontSize: '11px', color: 'var(--pulse-text-muted)', fontStyle: 'italic' }}>none</span>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '4px' }}>
                {subscribedRooms.map((r) => (
                  <span key={r} className="badge badge-violet" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    #{r}
                    <button
                      onClick={() => unsubscribe(r)}
                      style={{ background: 'transparent', color: 'inherit', padding: 0 }}
                      title="Leave room"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Message Broadcast Form */}
        <div className="telemetry-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
            <Send size={16} color="var(--pulse-accent-cyan)" />
            <span style={{ fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', color: 'var(--pulse-text-primary)' }}>
              Dispatch Custom Frame
            </span>
          </div>

          <form onSubmit={handleBroadcast}>
            <textarea
              rows={3}
              value={msgPayload}
              onChange={(e) => setMsgPayload(e.target.value)}
              placeholder="JSON or text payload"
              style={{ width: '100%', resize: 'vertical', fontSize: '11px', marginBottom: '10px' }}
            />
            <button
              type="submit"
              disabled={!isConnected}
              className="btn-primary"
              style={{ width: '100%', justifyContent: 'center' }}
            >
              <Send size={14} /> Broadcast to #{roomInput}
            </button>
          </form>
        </div>

        {/* 1-Click Load Generator Card */}
        <div className="telemetry-card" style={{
          border: '1px solid rgba(245, 158, 11, 0.4)',
          background: 'rgba(245, 158, 11, 0.04)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Zap size={16} color="var(--pulse-accent-amber)" />
              <span style={{ fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', color: 'var(--pulse-accent-amber)' }}>
                1-Click Traffic Generator
              </span>
            </div>
            <span className="badge badge-amber">[BURST TEST]</span>
          </div>

          <p style={{ fontSize: '11px', color: 'var(--pulse-text-secondary)', marginBottom: '10px' }}>
            Emits 500 wire frames at high frequency to verify cluster throughput, latency curves, and backpressure stability.
          </p>

          <button
            onClick={() => triggerBurstLoad(roomInput, 500)}
            disabled={!isConnected || isBursting}
            className="btn-primary"
            style={{
              width: '100%',
              justifyContent: 'center',
              background: 'var(--pulse-accent-amber)',
              color: '#07090E'
            }}
          >
            <Zap size={14} />
            {isBursting ? 'Emitting Burst (500 frames)...' : 'Trigger 500 msg/s Load Burst'}
          </button>

          {isBursting && burstProgress && (
            <div style={{ marginTop: '10px' }}>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: '10px',
                fontFamily: 'var(--font-mono)',
                color: 'var(--pulse-text-muted)',
                marginBottom: '4px'
              }}>
                <span>Burst Cadence</span>
                <span>{burstProgress.sent} / {burstProgress.total} ({Math.round((burstProgress.sent / burstProgress.total) * 100)}%)</span>
              </div>
              <div style={{
                height: '4px',
                width: '100%',
                background: 'rgba(255, 255, 255, 0.1)',
                borderRadius: '2px',
                overflow: 'hidden'
              }}>
                <div style={{
                  height: '100%',
                  width: `${(burstProgress.sent / burstProgress.total) * 100}%`,
                  background: 'var(--pulse-accent-amber)',
                  transition: 'width 0.1s linear'
                }} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Right Column: Message Activity & Raw Wire Frame Inspector */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', minWidth: 0 }}>
        {/* Upper Panel: Message Activity */}
        <div className="telemetry-card" style={{
          display: 'flex',
          flexDirection: 'column',
          height: '290px',
          position: 'relative',
          padding: '14px'
        }}>
          {/* Header */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '8px',
            paddingBottom: '8px',
            borderBottom: '1px solid var(--pulse-border-subtle)',
            flexWrap: 'wrap',
            gap: '8px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Activity size={16} color="var(--pulse-accent-emerald)" />
              <span style={{ fontSize: '13px', fontWeight: 600, textTransform: 'uppercase', color: 'var(--pulse-text-primary)' }}>
                Message Activity
              </span>
              <span className="badge badge-muted">
                {activities.length}/100
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <button
                onClick={clearActivities}
                className="btn-secondary"
                style={{ padding: '3px 8px', fontSize: '11px' }}
                title="Clear message activity history"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>

          {/* Activity Viewport */}
          <div
            ref={activityListRef}
            onScroll={handleActivityScroll}
            style={{
              flex: 1,
              overflowY: 'auto',
              background: 'var(--pulse-bg-sunken)',
              padding: '8px',
              borderRadius: '6px',
              border: '1px solid var(--pulse-border-subtle)',
              position: 'relative'
            }}
          >
            {activities.length === 0 ? (
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: 'var(--pulse-text-muted)',
                fontSize: '12px',
                gap: '6px',
                textAlign: 'center',
                padding: '24px 16px'
              }}>
                <Activity size={24} color="var(--pulse-text-muted)" style={{ opacity: 0.5 }} />
                <span style={{ fontWeight: 600, color: 'var(--pulse-text-secondary)' }}>No message activity yet</span>
                <span style={{ fontSize: '11px' }}>Send a room message to see activity here.</span>
              </div>
            ) : (
              activities.map((act) => (
                <MessageActivityItem key={act.id} activity={act} />
              ))
            )}
          </div>

          {/* Floating New Messages Pill */}
          {hasNewActivities && (
            <button
              onClick={scrollToNewestActivity}
              className="btn-secondary"
              style={{
                position: 'absolute',
                bottom: '22px',
                left: '50%',
                transform: 'translateX(-50%)',
                fontSize: '11px',
                padding: '4px 10px',
                background: 'var(--pulse-bg-card)',
                borderColor: 'var(--pulse-accent-cyan)',
                boxShadow: 'var(--pulse-glow-cyan)',
                zIndex: 10,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px'
              }}
            >
              <ArrowDown size={11} color="var(--pulse-accent-cyan)" /> New activity below
            </button>
          )}
        </div>

        {/* Lower Panel: Raw Wire Frame Inspector */}
        <div className="telemetry-card" style={{
          display: 'flex',
          flexDirection: 'column',
          height: '290px',
          padding: '14px'
        }}>
          {/* Inspector Header */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '8px',
            paddingBottom: '8px',
            borderBottom: '1px solid var(--pulse-border-subtle)',
            flexWrap: 'wrap',
            gap: '8px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Terminal size={16} color="var(--pulse-accent-cyan)" />
              <span style={{ fontSize: '13px', fontWeight: 600, textTransform: 'uppercase', color: 'var(--pulse-text-primary)' }}>
                Raw Wire Frame Inspector
              </span>
              <span className="badge badge-muted">
                Ring Buffer: {frames.length}/100
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {/* Direction Filter */}
              <div style={{ display: 'flex', borderRadius: '4px', overflow: 'hidden', border: '1px solid var(--pulse-border-subtle)' }}>
                {(['all', 'inbound', 'outbound'] as const).map((dir) => (
                  <button
                    key={dir}
                    onClick={() => setDirectionFilter(dir)}
                    style={{
                      padding: '3px 8px',
                      fontSize: '11px',
                      fontFamily: 'var(--font-mono)',
                      textTransform: 'uppercase',
                      background: directionFilter === dir ? 'var(--pulse-bg-card-hover)' : 'var(--pulse-bg-sunken)',
                      color: directionFilter === dir ? 'var(--pulse-accent-cyan)' : 'var(--pulse-text-secondary)',
                      border: 'none',
                      cursor: 'pointer'
                    }}
                  >
                    {dir}
                  </button>
                ))}
              </div>

              {/* Clear Frames */}
              <button
                onClick={clearFrames}
                className="btn-secondary"
                style={{ padding: '4px 8px', fontSize: '11px' }}
                title="Clear captured wire frames"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>

          {/* Frame List Viewport */}
          <div style={{
            flex: 1,
            overflowY: 'auto',
            background: 'var(--pulse-bg-sunken)',
            padding: '8px',
            borderRadius: '6px',
            border: '1px solid var(--pulse-border-subtle)'
          }}>
            {filteredFrames.length === 0 ? (
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: 'var(--pulse-text-muted)',
                fontSize: '12px',
                gap: '6px'
              }}>
                <Terminal size={24} color="var(--pulse-text-muted)" />
                <span>No wire frames captured yet. Connect and send traffic to inspect.</span>
              </div>
            ) : (
              filteredFrames.map((frame) => (
                <FrameItem key={frame.id} frame={frame} />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
