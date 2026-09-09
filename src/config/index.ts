import dotenv from 'dotenv';
import { PulseConfig } from '../types/index.js';

// Load .env if present
dotenv.config();

export type PulseServerOptions = Partial<PulseConfig>;
export type { PulseConfig };

export function loadConfig(overrides: PulseServerOptions = {}): PulseConfig {
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

  // Production Hardening configuration (Phase 10)
  const maxConnections =
    overrides.maxConnections ??
    parseInt(process.env.MAX_CONNECTIONS || '10000', 10);
  const maxRoomsPerConnection =
    overrides.maxRoomsPerConnection ??
    parseInt(process.env.MAX_ROOMS_PER_CONNECTION || '100', 10);
  const maxRoomIdLength =
    overrides.maxRoomIdLength ??
    parseInt(process.env.MAX_ROOM_ID_LENGTH || '128', 10);

  const allowedOrigins =
    overrides.allowedOrigins ??
    (process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
      : nodeEnv === 'production' ? [] : ['*']);

  const inboundRateLimitMax =
    overrides.inboundRateLimitMax ??
    parseInt(process.env.INBOUND_RATE_LIMIT_MAX || '100', 10);
  const inboundRateLimitBurst =
    overrides.inboundRateLimitBurst ??
    parseInt(process.env.INBOUND_RATE_LIMIT_BURST || '50', 10);

  const drainTimeoutMs =
    overrides.drainTimeoutMs ??
    parseInt(process.env.DRAIN_TIMEOUT_MS || '2000', 10);

  const trustProxy =
    overrides.trustProxy ??
    (process.env.TRUST_PROXY !== undefined ? process.env.TRUST_PROXY === 'true' : false);
  const trustedProxies =
    overrides.trustedProxies ??
    (process.env.TRUSTED_PROXIES
      ? process.env.TRUSTED_PROXIES.split(',').map((s) => s.trim()).filter(Boolean)
      : []);

  if (nodeEnv === 'production') {
    const knownDefaults = [
      'pulse-dev-secret-key-32chars-min',
      'pulse-distributed-realtime-secret-key-32chars!'
    ];
    if (!authSecret || knownDefaults.includes(authSecret)) {
      throw new Error('Production deployment must set a strong, non-default AUTH_SECRET.');
    }
    if (authSecret.length < 32) {
      throw new Error('AUTH_SECRET must be at least 32 characters long in production mode.');
    }
  }

  if (isNaN(port) || port < 0 || port > 65535) {
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

  if (isNaN(maxConnections) || maxConnections < 1) {
    throw new Error(`Invalid MAX_CONNECTIONS configuration: ${maxConnections}`);
  }

  if (isNaN(maxRoomsPerConnection) || maxRoomsPerConnection < 1) {
    throw new Error(`Invalid MAX_ROOMS_PER_CONNECTION configuration: ${maxRoomsPerConnection}`);
  }

  if (isNaN(maxRoomIdLength) || maxRoomIdLength < 8) {
    throw new Error(`Invalid MAX_ROOM_ID_LENGTH configuration: ${maxRoomIdLength}`);
  }

  if (isNaN(inboundRateLimitMax) || inboundRateLimitMax < 1) {
    throw new Error(`Invalid INBOUND_RATE_LIMIT_MAX configuration: ${inboundRateLimitMax}`);
  }

  if (isNaN(inboundRateLimitBurst) || inboundRateLimitBurst < 1) {
    throw new Error(`Invalid INBOUND_RATE_LIMIT_BURST configuration: ${inboundRateLimitBurst}`);
  }

  if (isNaN(drainTimeoutMs) || drainTimeoutMs < 100) {
    throw new Error(`Invalid DRAIN_TIMEOUT_MS configuration: ${drainTimeoutMs}`);
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
    eventLoopMonitorIntervalMs,
    maxConnections,
    maxRoomsPerConnection,
    maxRoomIdLength,
    allowedOrigins,
    inboundRateLimitMax,
    inboundRateLimitBurst,
    drainTimeoutMs,
    trustProxy,
    trustedProxies
  };
}
