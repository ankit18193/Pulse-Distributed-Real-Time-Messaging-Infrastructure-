# Changelog

All notable changes to Pulse are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
