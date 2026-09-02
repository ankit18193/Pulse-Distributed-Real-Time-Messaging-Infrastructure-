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
  const authSecret =
    overrides.authSecret ?? process.env.AUTH_SECRET ?? 'pulse-dev-secret-key-32chars-min';

  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT configuration: ${port}`);
  }

  return {
    port,
    host,
    nodeEnv,
    instanceId,
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
    maxPayloadBytes,
    authSecret
  };
}
