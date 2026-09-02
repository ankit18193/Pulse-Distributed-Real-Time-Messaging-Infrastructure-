/**
 * Pulse — Distributed Real-Time Messaging Infrastructure
 * Core Type Definitions (Phase 1)
 */

export interface PulseConfig {
  port: number;
  host: string;
  nodeEnv: 'development' | 'test' | 'production';
  instanceId: string;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  maxPayloadBytes: number;
  authSecret: string;
}

export type EventType =
  | 'SYS_CONNECT_ACK'
  | 'SYS_PING'
  | 'SYS_PONG'
  | 'SYS_ERROR'
  | 'SYS_SHUTDOWN'
  | 'ROOM_JOIN'
  | 'ROOM_JOIN_ACK'
  | 'ROOM_LEAVE'
  | 'ROOM_LEAVE_ACK'
  | 'ROOM_MESSAGE'
  | 'DIRECT_MESSAGE'
  | 'DELIVERY_ACK';

export interface EventTarget {
  roomId?: string;
  recipientId?: string;
}

export interface PulseEventEnvelope<T = unknown> {
  eventId: string;
  type: EventType;
  timestamp: number;
  senderId: string;
  target?: EventTarget;
  payload: T;
  correlationId?: string;
  ackRequired?: boolean;
}

export interface ConnectionContext {
  readonly connectionId: string;
  readonly userId: string;
  readonly roles: string[];
  readonly connectedAt: number;
  lastSeenAt: number;
}

export interface PulseErrorPayload {
  code: string;
  message: string;
  correlationId?: string;
  details?: Record<string, unknown>;
}
