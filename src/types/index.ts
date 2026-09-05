/**
 * Pulse — Distributed Real-Time Messaging Infrastructure
 * Core Type Definitions (Phase 2)
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
  idempotencyCapacity?: number;
  idempotencyTtlMs?: number;
  redisEnabled?: boolean;
  redisUrl?: string;
  redisHost?: string;
  redisPort?: number;
  redisPassword?: string;
  redisRetryMaxAttempts?: number;
  redisRetryInitialDelayMs?: number;
  redisRetryMaxDelayMs?: number;
  maxBufferedAmountBytes?: number;
  presenceTtlMs?: number;
  presenceFlushIntervalMs?: number;
  metricsEnabled?: boolean;
  metricsPath?: string;
  eventLoopMonitorIntervalMs?: number;
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
  | 'ROOM_BATCH_JOIN'
  | 'ROOM_BATCH_JOIN_ACK'
  | 'ROOM_MESSAGE'
  | 'DIRECT_MESSAGE'
  | 'PRESENCE_UPDATE'
  | 'ROOM_ROSTER'
  | 'DELIVERY_ACK';

export type PresenceStatus = 'ONLINE' | 'OFFLINE';

export interface PresenceUpdatePayload {
  userId: string;
  status: PresenceStatus;
  activeConnections: number;
  rooms?: string[];
}

export interface RoomRosterPayload {
  roomId: string;
  members: string[];
  totalOnline: number;
}

export interface EventTarget {
  roomId?: string;
  recipientId?: string;
}

export interface PulseEventEnvelope<T = unknown> {
  eventId: string;
  type: EventType;
  timestamp: number;
  senderId: string;
  seq?: number;
  target?: EventTarget;
  payload: T;
  correlationId?: string;
  ackRequired?: boolean;
  originInstanceId?: string;
  originTimestampMs?: number;
}

export interface ConnectionContext {
  readonly connectionId: string;
  readonly userId: string;
  readonly roles: string[];
  readonly connectedAt: number;
  lastSeenAt: number;
  lastSeenSeq: number;
}

export interface PulseErrorPayload {
  code: string;
  message: string;
  correlationId?: string;
  details?: Record<string, unknown>;
}

export * from '../metrics/types.js';
