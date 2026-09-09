/**
 * Pulse — Distributed Real-Time Messaging Infrastructure
 * Package Entrypoint (@ankit18193/pulse)
 *
 * Minimal, intentional public API surface. Internal messaging engines,
 * connection sweeps, presence Lua scripts, and token buckets remain encapsulated.
 */

// Core Server
export {
  PulseServer,
  type PulseServerHooks,
  type PulseServerDependencies
} from './core/PulseServer.js';

// Configuration
export {
  loadConfig,
  type PulseConfig,
  type PulseServerOptions
} from './config/index.js';

// Authentication & Utilities
export { Authenticator, type AuthResult } from './auth/Authenticator.js';
export { OriginMatcher } from './utils/OriginMatcher.js';
export { generateUUIDv7 } from './utils/uuidv7.js';

// Observability & Metrics
export {
  PulseMetricsRegistry,
  PrometheusSerializer
} from './metrics/index.js';

// Public Protocol Types & Envelopes
export type {
  PulseEventEnvelope,
  EventType,
  EventTarget,
  PresenceStatus,
  PresenceUpdatePayload,
  RoomRosterPayload,
  PulseErrorPayload,
  ConnectionContext
} from './types/index.js';
