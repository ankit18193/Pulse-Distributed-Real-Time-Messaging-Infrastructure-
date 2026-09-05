/**
 * Core type definitions for Pulse Phase 7 Chaos Engineering and Failure Injection.
 */

export type FaultState = 'NORMAL' | 'SEVERED' | 'BLACKHOLE' | 'DEGRADED';

export interface FaultProxyOptions {
  /**
   * Local port for the fault proxy to bind and listen on.
   */
  readonly listenPort: number;

  /**
   * Target upstream host to forward TCP traffic to.
   */
  readonly targetHost: string;

  /**
   * Target upstream port to forward TCP traffic to.
   */
  readonly targetPort: number;

  /**
   * Human-readable identifier for logging and metrics.
   */
  readonly name?: string;

  /**
   * Operating mode. When set to 'websocket', enables frame-aware RFC 6455 interception.
   * Defaults to 'tcp'.
   */
  readonly mode?: 'tcp' | 'websocket';
}

export interface LatencyFaultConfig {
  /**
   * Minimum delay to inject into the byte stream in milliseconds.
   */
  readonly minDelayMs: number;

  /**
   * Maximum delay to inject into the byte stream in milliseconds.
   */
  readonly maxDelayMs: number;
}

export interface DecodedWebSocketFrame {
  /**
   * Indicates whether this is the final fragment in a message.
   */
  readonly fin: boolean;

  /**
   * 3-bit reserved field.
   */
  readonly rsv: number;

  /**
   * RFC 6455 Opcode:
   * 0x0: Continuation
   * 0x1: Text frame
   * 0x2: Binary frame
   * 0x8: Connection Close
   * 0x9: Ping
   * 0xA: Pong
   */
  readonly opcode: number;

  /**
   * Whether the payload was masked.
   */
  readonly masked: boolean;

  /**
   * The 4-byte masking key if masked.
   */
  readonly maskKey?: Buffer;

  /**
   * Unmasked payload length in bytes.
   */
  readonly payloadLength: number;

  /**
   * Unmasked payload buffer.
   */
  readonly payload: Buffer;

  /**
   * UTF-8 decoded text if opcode === 0x1.
   */
  readonly text?: string;
}

/**
 * Predicate evaluating whether an RFC 6455 frame should be discarded.
 * Returns true to drop the frame, false to forward it downstream.
 */
export type FrameDropPredicate = (frame: DecodedWebSocketFrame) => boolean;

export interface ChaosTimingMetrics {
  /**
   * Timestamp (Date.now()) when the fault was actively injected.
   */
  faultInjectedAt: number;

  /**
   * Timestamp when the failure condition was observed or detected.
   */
  failureDetectedAt?: number;

  /**
   * Mean Time to Detect in milliseconds.
   */
  mttdMs?: number;

  /**
   * Timestamp when the fault was cleared or restored.
   */
  faultRestoredAt?: number;

  /**
   * Timestamp when the system resumed normal verified operation.
   */
  systemRecoveredAt?: number;

  /**
   * Mean Time to Recover in milliseconds.
   */
  mttrMs?: number;
}

export interface ChaosScenarioResult {
  readonly scenarioId: string;
  readonly name: string;
  readonly status: 'PASSED' | 'FAILED' | 'UNAVAILABLE';
  readonly timing: ChaosTimingMetrics;
  readonly metricsAsserted: Record<string, number | string>;
  readonly error?: string;
  readonly details?: Record<string, unknown>;
}

export interface ChaosScenarioContext {
  readonly pulsePortA: number;
  readonly pulsePortB: number;
  readonly redisHost: string;
  readonly redisPort: number;
  readonly redisProxyPort: number;
  readonly authSecret: string;
}

export interface ChaosScenario {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly execute: (ctx: ChaosScenarioContext) => Promise<ChaosScenarioResult>;
}
