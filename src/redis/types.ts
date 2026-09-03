import type { Redis } from 'ioredis';

export type RedisConnectionRole = 'publisher' | 'subscriber';

export type RedisConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnecting'
  | 'disconnected'
  | 'error';

export interface RedisConnectionOptions {
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  maxRetriesPerRequest?: number | null;
  retryMaxAttempts?: number;
  retryInitialDelayMs?: number;
  retryMaxDelayMs?: number;
  connectTimeoutMs?: number;
  customClientFactory?: (role: RedisConnectionRole) => Redis;
}

export interface RedisConnectionStatus {
  publisher: RedisConnectionState;
  subscriber: RedisConnectionState;
  isConnected: boolean;
}
