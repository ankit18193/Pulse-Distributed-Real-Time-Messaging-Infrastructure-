# Pulse Phase 10: Production Hardening & Operational Resilience Specification

**Date:** 2026-09-09  
**Status:** PROPOSED (YC Office Hours / Builder Mode Brainstorm)  
**Author:** Pulse Core Engineering & Antigravity  
**Target:** Production-Grade Stability, DoS Resilience, Memory Leak Immunity, and Operational Safety  

---

## 1. Executive Summary & Philosophy

Pulse has successfully completed Phases 1 through 9:
- Core distributed realtime clustering with Redis Pub/Sub, ZSET presence, and atomic Lua state transitions.
- High-performance RFC 6455 WebSocket engine with HMAC-SHA256 authentication and UUIDv7 idempotency.
- Embedded RouteX edge gateway with pre-101 failover.
- Real-time Mission Control dashboard with 60s SVG waveforms, event loop quantiles, and traffic sandbox.

**Phase 10 is NOT for random new features.**
It does NOT introduce Bluetooth, mesh networking, offline messaging, or chat UI features. It preserves all working behaviors from Phases 1–9.

Instead, Phase 10 addresses **real-world production vulnerabilities and operational limits** discovered through first-principles architectural auditing:
1. **Unbounded Connection Limits (Resource Exhaustion DoS)**
2. **Missing Inbound Message & Handshake Rate Limiting (CPU Flood)**
3. **Cross-Site WebSocket Hijacking (CSWSH) via Missing Origin Validation**
4. **Unbounded Dynamic Room Joining (Memory & Redis Channel Explosion)**
5. **Insecure Production Secret Fallback**
6. **Missing Unhandled Exception & Promise Rejection Traps**
7. **Immediate Socket Severing During Draining Window**
8. **Lack of Multi-Minute Soak & Memory Leak Verification**

---

## 2. First-Principles Production Gap Audit

Each of the 8 core operational areas has been evaluated and classified into:
- **`ALREADY SUFFICIENT`** (No change needed)
- **`MUST FIX`** (Hard production blocker — causes downtime, crashes, or security breaches)
- **`SHOULD FIX`** (Recommended operational hygiene)
- **`OPTIONAL`** (Nice-to-have, deferred beyond Phase 10)

---

### Area 1: WebSocket Reliability

| Item | Status | Evaluation & Production Rationale |
| :--- | :---: | :--- |
| **Connection Lifecycle** | `ALREADY SUFFICIENT` | Handshake (`SYS_CONNECT_ACK`), authenticated lifecycle, room membership, dispatching, clean teardown. |
| **Reconnect Behavior** | `ALREADY SUFFICIENT` | `PulseClientSession` implements decorrelated jitter backoff, bounded in-flight retry queue (max 100), automatic `ROOM_BATCH_JOIN` resubscription, seq counter resumption. |
| **Heartbeat Handling** | `ALREADY SUFFICIENT` | Active 30s interval, 10s timeout, sub-tick sweep timer in `HeartbeatManager`, `SYS_PING`/`SYS_PONG` and native frame support, socket termination on timeout. |
| **Malformed Frames** | `ALREADY SUFFICIENT` | `EventValidator` parses JSON safely, validates types, formats, correlation IDs, timestamps, rejecting bad frames with `SYS_ERROR` envelopes. |
| **Slow Consumers & Backpressure** | `ALREADY SUFFICIENT` | `Connection.send()` monitors `socket.bufferedAmount > maxBufferedAmountBytes`. Terminates slow consumers with close code 1008 and increments `pulse_messages_dropped_total{reason="slow_consumer"}`. |
| **Server Connection Concurrency Cap (`maxConnections`)** | **`MUST FIX`** | **Critical Gap:** Pulse currently has NO cap on total active connections. A sudden traffic spike or malicious script can open tens of thousands of sockets, exhausting OS file descriptors (`EMFILE`) and crashing Node.js. Must enforce `maxConnections` (default 10,000) and reject excess upgrades with `HTTP/1.1 503 Service Unavailable`. |
| **Per-IP Connection Limits** | **`SHOULD FIX`** | Prevents a single client IP from monopolizing all connection slots (e.g. max 50 concurrent connections per remote IP). |

---

### Area 2: Distributed Behavior

| Item | Status | Evaluation & Production Rationale |
| :--- | :---: | :--- |
| **Multi-Node Cluster Scaling** | `ALREADY SUFFICIENT` | Peer-to-peer scaling over Redis Pub/Sub (`pulse:room:*`, `pulse:user:*`), tested with multiple live nodes. |
| **Redis Outage Degradation** | `ALREADY SUFFICIENT` | Gracefully degrades to local-only routing, reports status `DEGRADED`, automatically resubscribes all rooms and re-registers presence leases on reconnect. |
| **Presence Consistency** | `ALREADY SUFFICIENT` | Redis ZSET leases with atomic Lua scripts for `ONLINE`/`OFFLINE` transitions. Heartbeat lease renewal every 15s with 60s TTL. Stale event protection via `PresenceEventTracker`. |
| **Node Failure Resilience** | `ALREADY SUFFICIENT` | Redis lease TTL automatically reaps dead node presence after 60s without manual operator intervention. |
| **Cross-Node Message Delivery & Deduplication** | `ALREADY SUFFICIENT` | `IdempotencyManager` tracks event IDs via LRU cache, detects payload conflicts (`EVENT_ID_CONFLICT`), replays cached ACKs for retried frames. Self-echo loopback suppression suppresses Redis echo when `originInstanceId === localInstanceId`. |
| **Unbounded Dynamic Room Subscriptions (Redis DoS)** | **`MUST FIX`** | **Critical Gap:** Any client can issue `ROOM_JOIN` for arbitrary room strings. Each unique room triggers `channelRegistry.subscribeRoom(roomId)`. A malicious actor can join 100,000 unique rooms, causing Node.js and Redis to track 100,000 channels and exhaust memory. Must enforce: (1) max rooms per connection (e.g. 100), (2) max room ID length (e.g. 128 chars), and (3) room name character validation (`^[a-zA-Z0-9:_\.\-]+$`). |

---

### Area 3: Failure Recovery

| Item | Status | Evaluation & Production Rationale |
| :--- | :---: | :--- |
| **Redis Outage / Recovery** | `ALREADY SUFFICIENT` | Tested with real Redis & `FaultProxy` (`RedisOutageAndRecovery.chaos.test.ts`). |
| **RouteX Gateway Failure** | `ALREADY SUFFICIENT` | RouteX edge gateway integrated with pre-101 connect-time failover (`EmbeddedRouteXIntegration.test.ts`). |
| **Process Crash Traps (`uncaughtException` / `unhandledRejection`)** | **`MUST FIX`** | **Critical Gap:** `src/index.ts` has no global `uncaughtException` or `unhandledRejection` traps. An unhandled promise rejection in an async callback abruptly terminates the process without cleaning up sockets or draining connections. Must log fatal diagnostic context and initiate emergency graceful shutdown. |
| **Draining Window & Staged Connection Handoff** | **`SHOULD FIX`** | **Production Gap:** In `PulseServer.stop()`, calling `drain()` immediately closes all sockets in the same tick. In production (Kubernetes rolling deploys), a node should enter `DRAINING`, signal `SYS_SHUTDOWN` with a draining window (e.g. 2–10 seconds), allow clients to finish in-flight frames and reconnect to sibling nodes, and only force-close remaining sockets upon grace period expiry. |
| **Partial Subsystem Failure** | `ALREADY SUFFICIENT` | Isolated fault domains: Redis outage doesn't take down local routing; RouteX error doesn't crash native WebSocket handler. |

---

### Area 4: Performance and Resource Stability

| Item | Status | Evaluation & Production Rationale |
| :--- | :---: | :--- |
| **Sustained Load Profiles** | `ALREADY SUFFICIENT` | 5 benchmark profiles measure 10k connections, 50k msgs/sec, backpressure, presence churn. |
| **Message Throughput** | `ALREADY SUFFICIENT` | Sub-millisecond dispatch, nanosecond local timing. |
| **Event-Loop Lag Telemetry** | `ALREADY SUFFICIENT` | Continuously monitored via `perf_hooks.monitorEventLoopDelay` (mean, p50, p90, p99, max), exported in Prometheus and Mission Control dashboard. |
| **Soak Testing & Memory Leak Verification** | **`MUST FIX`** | **Production Gap:** Existing tests run in brief bursts (< 2 minutes). Pulse lacks a sustained multi-minute soak test that verifies heap memory (`process.memoryUsage().heapUsed`), RSS, and active handles remain bounded under continuous churn (connect -> join -> flood -> leave -> disconnect). |
| **Redis Resource Bounds** | `ALREADY SUFFICIENT` | Reference-counted channels in `ChannelRegistry`, batch Lua scripts in `PresenceManager`. |

---

### Area 5: Security

| Item | Status | Evaluation & Production Rationale |
| :--- | :---: | :--- |
| **Authentication Engine** | `ALREADY SUFFICIENT` | HMAC-SHA256 tokens with `crypto.timingSafeEqual`, expiration checks (`exp`), `iat`, roles (`user`, `admin`), support for `Authorization: Bearer`, `?token=`, and `Sec-WebSocket-Protocol: token.<sig>`. |
| **Production Secret Enforcement (Fail-Safe)** | **`MUST FIX`** | **Security Vulnerability:** In `src/config/index.ts`, `authSecret` defaults to `'pulse-dev-secret-key-32chars-min'`. In `NODE_ENV=production`, starting Pulse with the default insecure secret must throw an immediate fatal error. |
| **Cross-Site WebSocket Hijacking (CSWSH) Defense** | **`MUST FIX`** | **Security Vulnerability:** Browsers send `Origin` headers on WebSocket handshakes. Without `allowedOrigins` checking, any website visited by a user can open a WebSocket to Pulse. Must add strict `allowedOrigins` configuration with wildcard, exact match, and same-origin validation. |
| **Inbound Message Rate Limiting (Token Bucket)** | **`MUST FIX`** | **DoS Vulnerability:** An authenticated client can spam 50,000 messages/second, saturating event loops and starving other users. Must implement a per-connection token bucket rate limiter (e.g. 100 msg/sec with 50-msg burst allowance), returning `RATE_LIMIT_EXCEEDED` on violation. |
| **Handshake / Upgrade Rate Limiting** | **`SHOULD FIX`** | Protects the HTTP upgrade endpoint from unauthenticated handshake flooding. |
| **HTTP Security Headers** | **`SHOULD FIX`** | Inject `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Content-Security-Policy` on HTTP responses. |

---

### Area 6: RouteX + Pulse Integration

| Item | Status | Evaluation & Production Rationale |
| :--- | :---: | :--- |
| **Unified Server Lifecycle** | `ALREADY SUFFICIENT` | Single HTTP port, single server instance, shared listening socket. |
| **HTTP/WS Dispatch Boundaries** | `ALREADY SUFFICIENT` | Clear demarcation: RouteX handles proxy/gateway routes first; non-handled requests fall through to Pulse native API/static/WS handlers. |
| **Gateway Failure Isolation** | `ALREADY SUFFICIENT` | RouteX errors caught cleanly, preventing crash. |
| **Shutdown Coordination** | `ALREADY SUFFICIENT` | `routexGateway.close()` called during `PulseServer.stop()`. |
| **Routing Correctness** | `ALREADY SUFFICIENT` | Tested in `EmbeddedRouteXIntegration.test.ts`. |

---

### Area 7: Observability

| Item | Status | Evaluation & Production Rationale |
| :--- | :---: | :--- |
| **Prometheus Exposition (`/metrics`)** | `ALREADY SUFFICIENT` | Bounded labels, histograms for latency, gauges for connections/rooms/event-loop lag, counters for messages received/delivered/dropped, Redis metrics. |
| **Decoupled Health Probes (`/healthz`, `/readyz`)** | `ALREADY SUFFICIENT` | Decoupled liveness and readiness semantics; readiness correctly reflects `DRAINING` (503) and Redis outage (`DEGRADED`). |
| **Structured JSON & ANSI Development Logging** | `ALREADY SUFFICIENT` | Clean, dual-mode logging with ISO timestamps, component tags, event names, correlation IDs. |
| **Security & Rate-Limit Telemetry Metrics** | **`SHOULD FIX`** | Export Prometheus counters: `pulse_connections_rejected_total{reason="max_connections | origin_forbidden | rate_limit"}`, and `pulse_rate_limit_exceeded_total`. |

---

### Area 8: Testing

| Item | Status | Evaluation & Production Rationale |
| :--- | :---: | :--- |
| **Unit & Integration Coverage** | `ALREADY SUFFICIENT` | 77 suites, 369 tests passing (100%). |
| **Deterministic Chaos Drills** | `ALREADY SUFFICIENT` | 7 FaultProxy chaos drills (TCP sever, blackhole, latency injection, Redis severance, ACK loss, frame reconstruction). |
| **Soak & Memory Leak Test Suite** | **`MUST FIX`** | Automated soak test running sustained 3–5 minute traffic cycles and asserting heap memory growth <= 15% and zero dangling socket handles. |
| **Security & DoS Validation Suite** | **`MUST FIX`** | Test suite covering: max connections rejection (503), CSWSH origin blocking (403), per-connection message rate limiting (SYS_ERROR 429), and room size bounds. |

---

## 3. Prioritized Phase 10 Execution Plan

Phase 10 is broken down into 4 focused, highly testable work packages:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    PHASE 10: PRODUCTION HARDENING PLAN                       │
├────────────────────────────────┬────────────────────────────────────────────┤
│ Work Package                   │ Priority & Scope                           │
├────────────────────────────────┼────────────────────────────────────────────┤
│ WP-1: Security & DoS Shields   │ MUST FIX (CSWSH Origin, Rate Limiting,     │
│                                │ Room Bounds, Prod Secret Guard)            │
├────────────────────────────────┼────────────────────────────────────────────┤
│ WP-2: Connection Concurrency   │ MUST FIX (maxConnections, Per-IP Cap,      │
│       & Draining Grace Period  │ 503 Rejection, Staged Shutdown Handoff)     │
├────────────────────────────────┼────────────────────────────────────────────┤
│ WP-3: Process Crash Traps &    │ MUST FIX (uncaughtException, Rejection,    │
│       Security Telemetry       │ Rejection Metrics, Security Counters)      │
├────────────────────────────────┼────────────────────────────────────────────┤
│ WP-4: Soak Test & Memory Leak  │ MUST FIX (3-5 min Soak Harness, Heap Delta │
│       Verification Suite       │ Guard, Active Handles Audit)               │
└────────────────────────────────┴────────────────────────────────────────────┘
```

---

### Work Package 1: Security & DoS Shields (MUST FIX)
1. **Origin Validation (CSWSH Defense):**
   - Add `allowedOrigins?: string[]` to `PulseConfig` (defaults to `['*']` in development, required or strictly parsed in production).
   - In `PulseServer.ts` on upgrade: If `req.headers.origin` is present and not matched, reject with `HTTP/1.1 403 Forbidden: Origin Not Allowed`.
2. **Inbound Message Rate Limiting (Token Bucket):**
   - Add lightweight in-memory `TokenBucket` to each `Connection` instance (e.g. capacity 100, refill rate 50 tokens/sec).
   - If bucket exhausted, drop message, return `SYS_ERROR` (`RATE_LIMIT_EXCEEDED`), and increment `pulse_rate_limit_exceeded_total`.
3. **Room Bounds & Validation:**
   - Enforce `maxRoomsPerConnection` (default 100). Reject joins beyond this limit.
   - Enforce `maxRoomIdLength` (default 128 chars) and regex `^[a-zA-Z0-9:_\.\-]+$`.
4. **Production Secret Guard:**
   - In `loadConfig()`: If `nodeEnv === 'production'` and `authSecret === 'pulse-dev-secret-key-32chars-min'`, throw a startup error.

---

### Work Package 2: Connection Limits & Graceful Draining (MUST FIX)
1. **Server Concurrency Cap (`maxConnections`):**
   - Add `maxConnections` to `PulseConfig` (default: 10,000).
   - In `PulseServer.ts` on upgrade: If `connectionManager.getCount() >= maxConnections`, reject with `HTTP/1.1 503 Service Unavailable: Max connections reached`.
2. **Staged Draining Window:**
   - In `PulseServer.stop(options)`:
     1. Mark `isShuttingDown = true` (readiness probe immediately returns 503).
     2. Reject new upgrades with 503.
     3. Broadcast `SYS_SHUTDOWN` to all active connections.
     4. Wait for `drainTimeoutMs` (e.g. 1–2s) before invoking `conn.close(1001)`, giving clients a clean opportunity to reconnect elsewhere.

---

### Work Package 3: Process Resilience & Operational Telemetry (MUST FIX / SHOULD FIX)
1. **Process Crash Traps in `src/index.ts`:**
   - Register `process.on('uncaughtException', ...)` and `process.on('unhandledRejection', ...)`.
   - Log error with component `ProcessTrap` and initiate emergency server stop with code 1.
2. **Operational Telemetry:**
   - Register Prometheus counters:
     - `pulse_connections_rejected_total{reason}` (`max_connections`, `origin_forbidden`, `auth_failed`).
     - `pulse_rate_limit_exceeded_total`.
3. **HTTP Security Headers:**
   - Add standard headers to HTTP responses in `PulseServer.ts`.

---

### Work Package 4: Soak Test & Memory Leak Verification (MUST FIX)
1. **Automated Soak Test Suite (`tests/soak/SustainedStability.soak.test.ts`):**
   - Run 1,000 rapid connect/subscribe/flood/leave/disconnect cycles over 3 minutes.
   - Take heap snapshots before and after garbage collection (`v8.getHeapStatistics()` / `process.memoryUsage()`).
   - Assert:
     - Heap growth delta < 15% (no retained closures or lingering Map entries).
     - Active rooms return to 0.
     - Active connections return to 0.
     - Idempotency cache size stays capped at `idempotencyCapacity`.

---

## 4. What Will NOT Be Changed
To maintain architectural discipline, the following boundaries are strictly enforced:
- **NO Chat UI / Offline Storage / Local DB:** Pulse remains pure real-time messaging infrastructure.
- **NO Protocol Changes:** RFC 6455 WebSockets and JSON event envelopes remain unchanged.
- **NO Core Algorithm Rewrites:** Working algorithms from Phases 1–9 (UUIDv7, presence Lua scripts, ChannelRegistry reference counting, FaultProxy) remain intact.
- **NO External Service Dependencies:** No new heavy infrastructure; Redis 7 remains the sole distributed coordination dependency.

---

## 5. Acceptance Criteria: When is Pulse "Production-Ready"?

Pulse will be officially certified **Production-Ready** when:
1. **DoS & Resource Exhaustion Defense:**
   - A client flooding messages > 100 msg/s is throttled with `RATE_LIMIT_EXCEEDED` without degrading peer latency.
   - Sockets exceeding `maxConnections` are rejected with HTTP 503.
   - Attempting to join > 100 rooms or send 10KB room IDs is rejected with `SYS_ERROR`.
2. **Security Compliance:**
   - Cross-origin upgrades from untrusted domains are blocked with HTTP 403.
   - Starting with default dev secret in production throws a fatal startup exception.
3. **Graceful Draining:**
   - Clients receive `SYS_SHUTDOWN` and have a staged window to reconnect before socket closure.
4. **Zero Memory Leaks:**
   - 3-minute sustained soak test demonstrates bounded heap memory and zero orphaned connection handles.
5. **Full Green Test Suite:**
   - 100% pass rate across all existing 77 test suites plus new security, soak, and draining test suites.

---

## 6. Recommended Next Review Gates

Before starting code implementation, the following decisions should be locked:
1. **`/plan-ceo-review`**: Strategic decision on default rate-limiting limits (e.g. 100 msg/s vs configurable tiers) and default `maxConnections` (10,000 vs dynamic based on memory).
2. **`/plan-eng-review`**: Engineering lock on token bucket data structure, origin matching algorithms, and soak test duration.
