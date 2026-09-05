/**
 * Pulse — Distributed Real-Time Messaging Infrastructure
 * Empirical Benchmarking Harness Types
 */

export type BenchmarkProfile =
  | 'broadcast'
  | 'direct'
  | 'presence'
  | 'ramp'
  | 'backpressure';

export interface BenchmarkConfig {
  target: string;
  profile: BenchmarkProfile;
  connections: number;
  durationSec: number;
  rampRate: number;
  messageRate: number;
  rooms: number;
  authSecret: string;
  json: boolean;
  forceHighConcurrency: boolean;
}

export interface PercentileStats {
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  count: number;
}

export interface BenchmarkResult {
  profile: BenchmarkProfile;
  target: string;
  durationSec: number;
  connectionsAttempted: number;
  connectionsEstablished: number;
  connectionsFailed: number;
  messagesSent: number;
  messagesReceived: number;
  messagesDropped: number;
  deliveryRatePercent: number;
  throughputMsgPerSec: number;
  latency: PercentileStats;
  connectLatency: PercentileStats;
  errors: string[];
  passed: boolean;
  slaViolations: string[];
}
