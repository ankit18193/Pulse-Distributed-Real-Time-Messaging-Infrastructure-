/**
 * Pulse — Distributed Real-Time Messaging Infrastructure
 * Core Observability and Metrics Type Definitions (Phase 6)
 */

export type MetricType = 'counter' | 'gauge' | 'histogram';

/**
 * Bounded label vocabularies to enforce the low-cardinality architectural invariant.
 * NEVER use dynamic identifiers (userId, connectionId, roomId, eventId) as metric labels.
 */
export const BOUNDED_EVENT_TYPES = [
  'SYS_CONNECT_ACK',
  'SYS_PING',
  'SYS_PONG',
  'SYS_ERROR',
  'SYS_SHUTDOWN',
  'ROOM_JOIN',
  'ROOM_JOIN_ACK',
  'ROOM_LEAVE',
  'ROOM_LEAVE_ACK',
  'ROOM_BATCH_JOIN',
  'ROOM_BATCH_JOIN_ACK',
  'ROOM_MESSAGE',
  'DIRECT_MESSAGE',
  'PRESENCE_UPDATE',
  'ROOM_ROSTER',
  'DELIVERY_ACK'
] as const;

export type EventTypeLabel = typeof BOUNDED_EVENT_TYPES[number];

export const BOUNDED_STATUSES = [
  'success',
  'error',
  'rejected',
  'timeout',
  'dropped',
  'accepted',
  'distributed_accepted',
  'conflict',
  'out_of_order'
] as const;

export type StatusLabel = typeof BOUNDED_STATUSES[number];

export const BOUNDED_REASONS = [
  'heartbeat_timeout',
  'slow_consumer',
  'client_close',
  'server_shutdown',
  'malformed_frame',
  'unauthorized',
  'duplicate',
  'stale_presence',
  'invalid_format'
] as const;

export type ReasonLabel = typeof BOUNDED_REASONS[number];

export const BOUNDED_DIRECTIONS = ['published', 'received'] as const;
export type DirectionLabel = typeof BOUNDED_DIRECTIONS[number];

/**
 * Prohibited label names that would cause unbounded cardinality explosions.
 */
export const PROHIBITED_LABEL_KEYS = [
  'userid',
  'user_id',
  'connectionid',
  'connection_id',
  'roomid',
  'room_id',
  'eventid',
  'event_id',
  'instanceid',
  'instance_id',
  'error',
  'error_message',
  'errormsg',
  'message',
  'payload'
] as const;

/**
 * Validates that the provided metric labels do not violate low-cardinality invariants.
 * Throws an Error if a prohibited label key is encountered.
 */
export function assertLowCardinalityLabels(labels?: Record<string, string>): void {
  if (!labels) {
    return;
  }

  for (const key of Object.keys(labels)) {
    const normalizedKey = key.toLowerCase();
    if (PROHIBITED_LABEL_KEYS.includes(normalizedKey as typeof PROHIBITED_LABEL_KEYS[number])) {
      throw new Error(
        `Low-cardinality violation: Label key "${key}" is prohibited in Prometheus metrics to prevent memory exhaustion.`
      );
    }
    const val = labels[key];
    if (typeof val !== 'string' || val.length > 64) {
      throw new Error(
        `Invalid label value for "${key}": Values must be strings with maximum length 64.`
      );
    }
  }
}

export type MetricLabels = Record<string, string>;

export interface MetricSample {
  name: string;
  labels?: MetricLabels;
  value: number;
}

export interface HistogramBucket {
  le: number; // upper bound, or Infinity for +Inf
  count: number;
}

export interface HistogramValue {
  buckets: HistogramBucket[];
  sum: number;
  count: number;
}

/**
 * Approved cumulative latency bucket boundaries in seconds:
 * 0.5ms, 1ms, 2ms, 5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1000ms
 */
export const DEFAULT_LATENCY_BUCKETS: readonly number[] = [
  0.0005,
  0.001,
  0.002,
  0.005,
  0.010,
  0.025,
  0.050,
  0.100,
  0.250,
  0.500,
  1.000
];

export interface MetricDefinition {
  name: string;
  help: string;
  type: MetricType;
  labelNames?: string[];
  buckets?: readonly number[];
}

export interface IMetric {
  readonly name: string;
  readonly help: string;
  readonly type: MetricType;
  readonly labelNames: readonly string[];
  reset(): void;
  collect(): MetricSample[];
}

export interface ICounter extends IMetric {
  inc(labels?: MetricLabels, value?: number): void;
  get(labels?: MetricLabels): number;
}

export interface IGauge extends IMetric {
  set(value: number, labels?: MetricLabels): void;
  inc(labels?: MetricLabels, value?: number): void;
  dec(labels?: MetricLabels, value?: number): void;
  get(labels?: MetricLabels): number;
}

export interface IHistogram extends IMetric {
  record(value: number, labels?: MetricLabels): void;
  getValue(labels?: MetricLabels): HistogramValue;
}

export interface PulseMetricsConfig {
  enabled: boolean;
  path: string;
  eventLoopMonitorIntervalMs: number;
}
