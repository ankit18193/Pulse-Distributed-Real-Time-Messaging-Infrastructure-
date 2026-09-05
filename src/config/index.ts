import dotenv from 'dotenv';
import { PulseConfig } from '../types/index.js';

// Load .env if present
dotenv.config();

export function loadConfig(overrides: Partial<PulseConfig> = {}): PulseConfig {
  const port = overrides.port ?? parseInt(process.env.PORT || '8080', 10);
  const host = overrides.host ?? process.env.HOST ?? '0.0.0.0';
  const nodeEnv = (overrides.nodeEnv ?? process.env.NODE_ENV ?? 'development') as
    | 'development'
    | 'test'
    | 'production';
  const instanceId = overrides.instanceId ?? process.env.INSTANCE_ID ?? 'pulse-node-1';
  const heartbeatIntervalMs =
    overrides.heartbeatIntervalMs ??
    parseInt(process.env.HEARTBEAT_INTERVAL_MS || '30000', 10);
  const heartbeatTimeoutMs =
    overrides.heartbeatTimeoutMs ??
    parseInt(process.env.HEARTBEAT_TIMEOUT_MS || '10000', 10);
  const maxPayloadBytes =
    overrides.maxPayloadBytes ??
    parseInt(process.env.MAX_PAYLOAD_BYTES || '65536', 10);
  const maxBufferedAmountBytes =
    overrides.maxBufferedAmountBytes ??
    parseInt(process.env.MAX_BUFFERED_AMOUNT_BYTES || '1048576', 10);
  const authSecret =
    overrides.authSecret ?? process.env.AUTH_SECRET ?? 'pulse-dev-secret-key-32chars-min';

  const idempotencyCapacity =
    overrides.idempotencyCapacity ??
    parseInt(process.env.IDEMPOTENCY_CAPACITY || '10000', 10);
  const idempotencyTtlMs =
    overrides.idempotencyTtlMs ??
    parseInt(process.env.IDEMPOTENCY_TTL_MS || '60000', 10);

  // Redis configuration (Phase 3)
  const redisEnabled =
    overrides.redisEnabled ??
    (process.env.REDIS_ENABLED !== undefined
      ? process.env.REDIS_ENABLED === 'true'
      : Boolean(process.env.REDIS_URL));

  const redisUrl = overrides.redisUrl ?? process.env.REDIS_URL;
  const redisHost = overrides.redisHost ?? process.env.REDIS_HOST ?? '127.0.0.1';
  const redisPort =
    overrides.redisPort ??
    parseInt(process.env.REDIS_PORT || '6379', 10);
  const redisPassword = overrides.redisPassword ?? process.env.REDIS_PASSWORD;

  const redisRetryMaxAttempts =
    overrides.redisRetryMaxAttempts ??
    parseInt(process.env.REDIS_RETRY_MAX_ATTEMPTS || '10', 10);
  const redisRetryInitialDelayMs =
    overrides.redisRetryInitialDelayMs ??
    parseInt(process.env.REDIS_RETRY_INITIAL_DELAY_MS || '100', 10);
  const redisRetryMaxDelayMs =
    overrides.redisRetryMaxDelayMs ??
    parseInt(process.env.REDIS_RETRY_MAX_DELAY_MS || '3000', 10);

  // Presence configuration (Phase 4)
  const presenceTtlMs =
    overrides.presenceTtlMs ??
    parseInt(process.env.PRESENCE_TTL_MS || '60000', 10);
  const presenceFlushIntervalMs =
    overrides.presenceFlushIntervalMs ??
    parseInt(process.env.PRESENCE_FLUSH_INTERVAL_MS || '15000', 10);

  // Observability & Metrics configuration (Phase 6)
  const metricsEnabled =
    overrides.metricsEnabled ??
    (process.env.METRICS_ENABLED !== undefined
      ? process.env.METRICS_ENABLED === 'true'
      : true);
  const metricsPath = overrides.metricsPath ?? process.env.METRICS_PATH ?? '/metrics';
  const eventLoopMonitorIntervalMs =
    overrides.eventLoopMonitorIntervalMs ??
    parseInt(process.env.EVENT_LOOP_MONITOR_INTERVAL_MS || '10000', 10);

  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT configuration: ${port}`);
  }

  if (isNaN(maxBufferedAmountBytes) || maxBufferedAmountBytes < 1024) {
    throw new Error(`Invalid MAX_BUFFERED_AMOUNT_BYTES configuration: ${maxBufferedAmountBytes}`);
  }

  if (isNaN(presenceTtlMs) || presenceTtlMs < 1000) {
    throw new Error(`Invalid PRESENCE_TTL_MS configuration: ${presenceTtlMs}`);
  }

  if (isNaN(presenceFlushIntervalMs) || presenceFlushIntervalMs < 500 || presenceFlushIntervalMs >= presenceTtlMs) {
    throw new Error(
      `Invalid PRESENCE_FLUSH_INTERVAL_MS configuration (${presenceFlushIntervalMs}) must be >= 500 and < presenceTtlMs (${presenceTtlMs})`
    );
  }

  if (redisEnabled) {
    if (isNaN(redisPort) || redisPort < 1 || redisPort > 65535) {
      throw new Error(`Invalid REDIS_PORT configuration: ${redisPort}`);
    }
    if (isNaN(redisRetryMaxAttempts) || redisRetryMaxAttempts < 1) {
      throw new Error(`Invalid REDIS_RETRY_MAX_ATTEMPTS configuration: ${redisRetryMaxAttempts}`);
    }
    if (isNaN(redisRetryInitialDelayMs) || redisRetryInitialDelayMs < 0) {
      throw new Error(`Invalid REDIS_RETRY_INITIAL_DELAY_MS configuration: ${redisRetryInitialDelayMs}`);
    }
    if (isNaN(redisRetryMaxDelayMs) || redisRetryMaxDelayMs < redisRetryInitialDelayMs) {
      throw new Error(
        `Invalid REDIS_RETRY_MAX_DELAY_MS configuration (${redisRetryMaxDelayMs}) must be >= initial delay (${redisRetryInitialDelayMs})`
      );
    }
  }

  return {
    port,
    host,
    nodeEnv,
    instanceId,
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
    maxPayloadBytes,
    maxBufferedAmountBytes,
    authSecret,
    idempotencyCapacity,
    idempotencyTtlMs,
    redisEnabled,
    redisUrl,
    redisHost,
    redisPort,
    redisPassword,
    redisRetryMaxAttempts,
    redisRetryInitialDelayMs,
    redisRetryMaxDelayMs,
    presenceTtlMs,
    presenceFlushIntervalMs,
    metricsEnabled,
    metricsPath,
    eventLoopMonitorIntervalMs
  };
}
