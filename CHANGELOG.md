# Changelog

All notable changes to Pulse are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-09-09

### Added
- **Official NPM Server Package (`@ankit18193/pulse`)**: Packaged Pulse as a publish-ready pure ESM package with dual entrypoint support, TypeScript declarations (`.d.ts`), sourcemaps, and strict encapsulation.
- **Conditional Subpath Exports Map**: Defined granular exports for `.` (core server), `./config` (configuration schemas), `./types` (protocol event envelopes), and `./metrics` (Prometheus metrics registry).
- **Standalone CLI Runner (`dist/bin/pulse-server.js`)**: Executable binary mapped to `pulse-server` and `npx @ankit18193/pulse`, supporting `--help`, `--version`, signal traps (`SIGINT`/`SIGTERM`), and fatal error boundaries.
- **Strict Public API Encapsulation**: Curated public API exporting `PulseServer`, `loadConfig`, `Authenticator`, `OriginMatcher`, `generateUUIDv7`, and `PulseMetricsRegistry`. Internal classes (`ConnectionManager`, `MessageDispatcher`, `PresenceManager`, `IdempotencyManager`, and Lua scripts) remain private.
- **Flexible Options Constructor**: `new PulseServer(options?: PulseServerOptions)` supporting partial overrides with safe fallbacks and runtime validation.
- **Reference Consumer Application (`examples/minimal-consumer/`)**: Runnable standalone consumer project demonstrating server startup, JWT authentication, room clustering, message broadcasting, and delivery acknowledgements.
- **Package Integrity & Distribution Test Suite (`tests/package/`)**: Added automated tests verifying `npm pack` tarball contents, zero test/source leakage, and end-to-end consumer integration.
- **Apache-2.0 License**: Added official open-source license file.
- **13-Chapter Developer Manual (`README.md`)**: Comprehensive documentation covering quick start, CLI usage, configuration options, protocol specifications, presence tracking, and Prometheus metrics scraping.

### Fixed
- **HTTP Upgrade TCP Error Resilience (`ISSUE-001`)**: Bound error listener to upgrade socket immediately upon connection to cleanly absorb client TCP resets (`ECONNRESET`) during rejected handshakes without causing unhandled process exceptions.
- **Graceful Redis Shutdown Flushes**: Made `cleanupAndFinalize()` in `PulseServer` asynchronous to ensure complete Redis pub/sub disconnections and channel registry teardown before server shutdown resolves.

## [0.3.0] - 2026-09-09

### Added
- **Atomic Connection Admission Control (`src/core/ConnectionManager.ts`)**: Synchronous slot reservation with `tryAcquireSlot()` and `releasePendingSlot()`, strictly preventing race conditions during concurrent upgrade spikes past `maxConnections`. Returns HTTP 503 (`max_connections`).
- **Inbound Message Rate Limiting (`src/utils/TokenBucket.ts`)**: Allocation-free token bucket algorithm on established WebSocket connections. Protocol-compliant rejection returns `SYS_ERROR` frame with code `RATE_LIMIT_EXCEEDED` (never HTTP 429 over established sockets). Persistent abusive connections (>= 10 drops in 10s) are terminated with RFC 1008 ("Policy Violation").
- **Cross-Site WebSocket Hijacking (CSWSH) Origin Defense (`src/utils/OriginMatcher.ts`)**: RFC 6455 Origin validation supporting exact hosts, wildcard subdomains (`https://*.domain.com`), and permissive dev/test wildcards (`*`). Rejects forbidden origins during upgrade with HTTP 403 (`origin_forbidden`). Non-browser native clients without Origin headers are permitted.
- **Room Subscription Bounds & Input Sanitation (`src/core/MessageDispatcher.ts`)**: Validates room IDs against `^[a-zA-Z0-9:_\.\-]+$` and bounded length (`maxRoomIdLength`, default 128) returning `INVALID_ROOM_ID`. Limits max rooms per socket (`maxRoomsPerConnection`, default 256) returning `MAX_ROOMS_EXCEEDED`.
- **Graceful Draining & Staged Handoff Window (`src/core/PulseServer.ts`)**: Staged handoff timeout (`drainTimeoutMs`, default 2000ms) with `/readyz` 503 status, active client broadcast of `SYS_SHUTDOWN`, and rejection of new connections. Force-closes unmigrated sockets with RFC 1001 ("Going Away").
- **Fatal Process Error Traps (`src/index.ts`)**: Process-level handlers for `uncaughtException` and `unhandledRejection` logging structured JSON error diagnostics, executing emergency resource cleanup (max 3s), and exiting non-zero (`process.exit(1)`).
- **Production Configuration Fail-Safe (`src/config/index.ts`)**: Strictly rejects default `AUTH_SECRET` values in `NODE_ENV=production` and enforces a minimum 32-character key length.
- **HTTP Security Headers (`src/core/PulseServer.ts`)**: Injects `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY` on all HTTP endpoints.
- **Prometheus Telemetry Instrumentation (`src/metrics/telemetry.ts`)**: Added `pulse_connections_rejected_total{reason}` and `pulse_rate_limit_exceeded_total{direction}` counters under low-cardinality label invariants.
- **Dedicated Long-Running Soak Test (`tests/soak/SustainedStability.soak.test.ts`)**: Endurance soak runner under `npm run test:soak` using explicit garbage collection (`--expose-gc`) to enforce `< 15%` post-GC heap growth after sustained connection and message churn.

## [0.2.0] - 2026-09-08

### Added
- **Pulse Mission Control Dashboard (`dashboard/`)**: High-density React 18 + Vite + TypeScript observability dashboard styled with the native Obsidian Void design system (`DESIGN.md`).
- **Real-Time Throughput Waveform (`ThroughputChart.tsx`)**: 60-second sliding dual-channel SVG telemetry waveform tracking inbound and outbound traffic rates.
- **Node.js Event Loop Lag Gauges (`EventLoopGauge.tsx`)**: Live p50, p90, and p99 lag gauges with color-coded operational thresholds.
- **Distributed Topology Flow (`TopologyGrid.tsx`)**: Visual node network state, Redis pub/sub link status, and peer instance discovery.
- **RouteX Gateway Inspector (`GatewayInspector.tsx`)**: Real-time RouteX edge gateway status, reverse proxy route mappings, and backpressure metrics.
- **Interactive Traffic Sandbox (`TrafficSandbox.tsx`)**: In-dashboard RFC 6455 WebSocket client supporting token authentication, room subscriptions, message dispatching, and a 1-click burst load generator (~26k msg/s).
- **Zero-Dependency Static Asset Serving**: Embedded static SPA server in `PulseServer.ts` at `/dashboard/` with path traversal shielding (`403 Forbidden`) and canonical redirects (`301 Moved Permanently`).
- **Telemetry Endpoints**: Added `GET /api/stats` and `GET /api/telemetry` with full CORS preflight support.
- **ANSI Terminal Logger (`src/utils/logger.ts`)**: Colorized one-line logs for development mode while preserving JSON logging for production and tests.

### Fixed
- Fixed dev-mode root bootstrap in `src/index.ts` to support both `index.ts` (via `tsx watch`) and `index.js` (via Node).
- Implemented path traversal protection in static file handler to block encoded traversal sequences.
- Added automatic 301 redirect from `/dashboard` to `/dashboard/`.
- Attached error listeners to `fs.createReadStream` to prevent unhandled stream errors.
- Added optional Auth Token input to Traffic Sandbox for direct testing against authenticated clusters.
- Resolved port collision in RedisOutageAndRecovery chaos drill by switching to dedicated isolation ports (9225/9226).
