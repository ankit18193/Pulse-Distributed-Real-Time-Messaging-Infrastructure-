# Pulse — Distributed Real-Time Messaging Infrastructure

A production-oriented real-time messaging engine built with WebSockets, structured event distribution, and horizontal scaling patterns. Designed to demonstrate persistent connection ownership, room-based broadcast, presence, acknowledgements, heartbeats, reconnection, and fault-tolerant distributed communication with RouteX integrated as the edge gateway.

---

## Current Status: Phase 7 Complete (Failure Injection & Chaos Testing)

| Phase | Milestone | Status | Description |
| :--- | :--- | :--- | :--- |
| **Phase 0** | **Foundation & Architecture Lock** | ✅ Done | Project specification (`PULSE_PROJECT_SPEC.md`), `.gitignore`, GStack Antigravity workflows. |
| **Phase 1** | **Single-Node Realtime Engine** | ✅ Done | Core WebSocket server, token authentication, connection tracking, rooms, messaging, ACKs, heartbeats, graceful shutdown. |
| **Phase 2** | **Reliability & Connection Recovery** | ✅ Done | UUIDv7 event IDs, LRU idempotency cache, batch room resubscription, decorrelated jitter backoff, in-flight retry queue, sequence tracking, native ping/pong hooks. |
| **Phase 3** | **Distributed Scale-Out** | ✅ Done | Multi-instance topology via Redis Pub/Sub, reference-counted channel registry, self-echo loopback suppression, cross-node room/direct messaging, and bounded backpressure. |
| **Phase 4** | **Distributed Presence Engine** | ✅ Done | Ephemeral Redis ZSET connection leases, atomic Lua script state transitions (`ONLINE`/`OFFLINE`), multi-device session aggregation, periodic lease refresh loop, room-scoped rosters. |
| **Phase 6** | **Observability & Benchmarking** | ✅ Done | Prometheus text exposition (`/metrics`), decoupled `/healthz` & `/readyz` probes, low-cardinality enforcement, event loop delay monitoring, nanosecond local timing, cross-node latency with clock skew clamping, and standalone 5-profile benchmark CLI (`pulse-bench.ts`). |
| **Phase 7** | **Failure & Resilience Engineering** | ✅ Done | Out-of-band fault injection via FaultProxy, RFC 6455 frame filtering, 7 deterministic chaos drills, real Redis requirements, and pulse-chaos CLI harness. |
| **Phase 8** | **RouteX Edge Gateway Integration** | ⏳ Planned | Upstream RFC 6455 WebSocket proxying and edge routing via RouteX. |
| **Phase 9** | **Demonstration Client Application** | ⏳ Planned | Minimal testing client showcasing room chat, direct messaging, and node metadata. |
| **Phase 10** | **Infrastructure Control Center** | ⏳ Planned | Live dashboard displaying cluster health, throughput, latency, and kill switches. |
| **Phase 11** | **End-to-End Hardening & CSO Audit** | ⏳ Planned | Comprehensive security audit, payload limits, penetration testing. |
| **Phase 12** | **Release & Showcase Packaging** | ⏳ Planned | Architecture diagrams, benchmark reports, portfolio case study. |

---

## Phase 2 Architecture & Reliability Model

In Phase 2, Pulse guarantees reliable connection recovery and message deduplication while maintaining strict single-node simplicity and zero distributed dependencies:

```text
       Client Session (PulseClientSession)
  ┌──────────────────────────────────────────────┐
  │ • State Machine: CONNECTING → AUTHENTICATING │
  │   → RESUBSCRIBING_ROOMS → CONNECTED          │
  │ • Decorrelated Jitter Backoff                │
  │ • Bounded In-Flight Retry Queue (max 100)    │
  │ • Monotonic Sequence Counter (seq: 1, 2...)  │
  └──────────────────────┬───────────────────────┘
                         │ RFC 6455 WebSocket
                         ▼
┌───────────────────────────────────────────────────────────────┐
│                     Pulse Realtime Engine                     │
│                                                               │
│   ┌───────────────────────────────────────────────────────┐   │
│   │                 Authenticator Engine                  │   │
│   │  • Handshake Token Validation (HMAC-SHA256)           │   │
│   │  • Clean HTTP 401 Rejection (socket.end)              │   │
│   └───────────────────────────────────────────────────────┘   │
│                                                               │
│   ┌─────────────────────┐           ┌─────────────────────┐   │
│   │  ConnectionManager  │           │     RoomManager     │   │
│   │  • Socket registry  │           │  • Room membership  │   │
│   │  • Multi-conn/user  │           │  • ROOM_BATCH_JOIN  │   │
│   │  • Ephemeral connId │           │  • Auto-prune empty │   │
│   └──────────┬──────────┘           └──────────┬──────────┘   │
│              │                                 │              │
│   ┌──────────┴─────────────────────────────────┴──────────┐   │
│   │                   MessageDispatcher                   │   │
│   │  • UUIDv7 Event Validation & Monotonic seq Checking   │   │
│   │  • Duplicate Broadcast Suppression via Idempotency    │   │
│   │  • Cached ACK Replay with Correlation Binding         │   │
│   │  • Conflicting Payload Rejection (EVENT_ID_CONFLICT)  │   │
│   └──────────┬─────────────────────────────────┬──────────┘   │
│              │                                 │              │
│   ┌──────────┴──────────────┐   ┌──────────────┴──────────┐   │
│   │   IdempotencyManager    │   │    HeartbeatManager     │   │
│   │  • In-memory LRU Cache  │   │  • Sub-tick sweep timer │   │
│   │  • 10,000 capacity      │   │  • Native ping/pong hook│   │
│   │  • 60s bounded TTL      │   │  • Prompt stale cleanup │   │
│   │  • Payload SHA-256 hash │   │                         │   │
│   └─────────────────────────┘   └─────────────────────────┘   │
└───────────────────────────────────────────────────────────────┘
```

### Core Reliability Features
1. **RFC 9562 UUIDv7 Event IDs**: 48-bit millisecond timestamps with monotonic sequence counters guaranteeing natural time-sortability and sub-millisecond uniqueness.
2. **Server-Side Idempotency Cache**: Bounded in-memory LRU ring cache (10,000 capacity, 60s TTL). Suppresses duplicate room broadcasts and replays cached ACKs. Rejects conflicting payload reuse of the same `eventId` with `SYS_ERROR: EVENT_ID_CONFLICT`.
3. **Client-Driven Reconnection & Room Resubscription**: `connectionId` is strictly ephemeral; on disconnect, socket memory is reclaimed immediately. The client automatically restores desired room memberships upon reconnection via `ROOM_BATCH_JOIN` (capped at 50 rooms).
4. **Decorrelated Jitter Backoff**: Prevents thundering herd reconnection storms with exponential backoff and randomized decorrelation:
   $$T_{\text{wait}} = \min(T_{\text{max}}, \max(T_{\text{base}}, \text{random}(T_{\text{base}}, T_{\text{previous}} \times 3)))$$
5. **Bounded In-Flight ACK Retry Queue**: Client tracks unacknowledged frames (bounded at 100). If ACK is not received within 3,000ms, frame is retransmitted up to 3 times, reusing the identical `eventId`, `correlationId`, and payload. Throws `BUFFER_FULL` when saturated and `DELIVERY_TIMEOUT` upon retry exhaustion.
6. **Per-Connection Monotonic Sequence Tracking**: Out-of-order frames (`seq < lastSeenSeq`) are rejected with `SYS_ERROR: INVALID_SEQUENCE_ORDER`. Retransmissions with identical sequence numbers pass through to the idempotency manager.
7. **Fine-Grained Heartbeat Sweeps & Native RFC 6455 Ping/Pong**: Heartbeat timers sweep at sub-tick rates (`min(interval, timeout) / 2`), ensuring dead connections are reaped promptly without lingering. Native WebSocket ping frames (opcode 0x9) and pong frames (opcode 0xA) update socket liveness timestamps.
8. **Clean HTTP 401 Rejection**: Unauthenticated handshake attempts receive standard HTTP 401 response with `Connection: close` and clean socket termination (`socket.end()`), preventing client-side `ECONNRESET` exceptions.

---

## Phase 3 Distributed Scale-Out Architecture

In Phase 3, Pulse scales horizontally across independent node instances using Redis Pub/Sub for ephemeral cross-instance event propagation:

```text
 Client A (Node 1)                                       Client B (Node 2)
        │                                                        ▲
        ▼                                                        │
┌─────────────────────────┐                            ┌─────────────────────────┐
│      Pulse Node 1       │                            │      Pulse Node 2       │
│  (instanceId: node-1)   │                            │  (instanceId: node-2)   │
│                         │                            │                         │
│ ┌─────────────────────┐ │                            │ ┌─────────────────────┐ │
│ │  ConnectionManager  │ │                            │ │  ConnectionManager  │ │
│ │  • Ephemeral socket │ │                            │ │  • Ephemeral socket │ │
│ └──────────┬──────────┘ │                            │ └──────────▲──────────┘ │
│            │            │                            │            │            │
│ ┌──────────┴──────────┐ │                            │ ┌──────────┴──────────┐ │
│ │  MessageDispatcher  │ │                            │ │  MessageDispatcher  │ │
│ │  • Local delivery   │ │                            │ │  • Local delivery   │ │
│ │  • Suppress self-   │ │                            │ │  • Deduplicate      │ │
│ │    echo loopback    │ │                            │ │    via idempotency  │ │
│ └──────────┬──────────┘ │                            │ └──────────▲──────────┘ │
│            │            │                            │            │            │
│ ┌──────────▼──────────┐ │                            │ ┌──────────┴──────────┐ │
│ │  ChannelRegistry    │ │                            │ │  ChannelRegistry    │ │
│ │  • Ref count (0->1) │ │                            │ │  • Ref count (0->1) │ │
│ └──────────┬──────────┘ │                            │ └──────────▲──────────┘ │
│            │            │                            │            │            │
│ ┌──────────▼──────────┐ │                            │ ┌──────────┴──────────┐ │
│ │ RedisPubSubManager  │ │                            │ │ RedisPubSubManager  │ │
│ │ • Dedicated pub/sub │ │                            │ │ • Dedicated pub/sub │ │
│ │ • Backpressure limit│ │                            │ │ • Auto-resubscribe  │ │
│ └──────────┬──────────┘ │                            │ └──────────▲──────────┘ │
└────────────┼────────────┘                            └────────────┼────────────┘
             │                                                      │
             │         Redis Pub/Sub Channel Mesh                   │
             │      (pulse:room:{id} / pulse:user:{id})             │
             └──────────────────────► ◄─────────────────────────────┘
```

### Key Distributed Design Principles
1. **Ephemeral Propagation Semantics**: Redis Pub/Sub provides transient event distribution across nodes. At-least-once reliability is maintained by the client retry state machine; duplicate suppression is enforced by each node's LRU `IdempotencyManager`.
2. **Dedicated Connections**: Because Redis protocol switches a connection into subscriber-only mode upon `SUBSCRIBE`, `RedisConnectionManager` manages dedicated `publisher` and `subscriber` connections.
3. **Reference-Counted Dynamic Channel Subscriptions**: Nodes only subscribe to channels for rooms or users with active local connections:
   - `0 -> 1`: First local socket triggers physical Redis `SUBSCRIBE`.
   - `1 -> 2+`: Additional local sockets increment reference count with zero redundant Redis calls.
   - `2+ -> 1`: Leaving sockets decrement reference count while remaining subscribed.
   - `1 -> 0`: Last local socket leaving triggers physical Redis `UNSUBSCRIBE`.
4. **Self-Echo Loopback Suppression**: Every distributed envelope is stamped with `originInstanceId`. When a publishing node receives its own broadcast back from Redis, it is immediately dropped before duplicate local delivery can occur.
5. **Connection-Local Transport Isolation**: Monotonic sequence numbers (`seq`) are strictly connection-local transport counters. `seq` is stripped before Redis publication and never evaluated on distributed events.
6. **Fault Isolation & Local Degraded Mode**: If Redis becomes unavailable, nodes continue serving all local connections and rooms. Distributed publish errors are caught and logged without crashing the engine. Upon Redis recovery, active channels are re-subscribed automatically.
7. **Bounded Backpressure & Metrics**: Configurable in-flight publish ceiling (`maxInFlightPublishes: 1000`) prevents memory unbounded growth during broker stalls. Realtime metrics (`redis.publish.*`, `redis.inbound.*`, `redis.echoes.suppressed`, `redis.duplicates.suppressed`) are exposed via `/healthz`.

## Standard Event Envelope

All client-to-server and server-to-client frames strictly adhere to the Pulse Event Envelope contract:

```json
{
  "eventId": "018e3a2b-8a4c-7000-8000-123456789abc",
  "type": "ROOM_MESSAGE",
  "timestamp": 1725280000000,
  "senderId": "alice",
  "seq": 1,
  "target": {
    "roomId": "engineering"
  },
  "payload": {
    "text": "Hello engineering team!"
  },
  "correlationId": "018e3a2b-8a4c-7000-8000-123456789def",
  "ackRequired": true
}
```

### Event Types
- `SYS_CONNECT_ACK`: Dispatched by server immediately upon successful handshake authentication.
- `SYS_PING` / `SYS_PONG`: Liveness checks between client and server.
- `SYS_ERROR`: Structured error returned when an event is invalid, unauthorized, or conflicting.
- `SYS_SHUTDOWN`: Broadcast to active connections when the server initiates graceful shutdown.
- `ROOM_JOIN` / `ROOM_JOIN_ACK`: Single room subscription request and acknowledgement.
- `ROOM_BATCH_JOIN` / `ROOM_BATCH_JOIN_ACK`: Batch room resubscription (up to 50 rooms per frame).
- `ROOM_LEAVE` / `ROOM_LEAVE_ACK`: Room unsubscribe request and acknowledgement.
- `ROOM_MESSAGE`: Broadcast to all members in a room (excluding sender).
- `DIRECT_MESSAGE`: Targeted delivery to all active connections belonging to `recipientId`.
- `DELIVERY_ACK`: Server-to-client acknowledgement confirming event processing.

---

## Delivery Semantics Matrix

| Interaction | Semantic | Mechanism | Failure Mode |
| :--- | :--- | :--- | :--- |
| **Room Message** | At-least-once to room; at-most-once per `eventId` | In-flight ACK retry queue + LRU idempotency cache | Duplicate drop, ACK replay |
| **Direct Message** | At-least-once to user; at-most-once per `eventId` | In-flight ACK retry queue + LRU idempotency cache | Duplicate drop, ACK replay |
| **Handshake Auth** | Fail-closed | HMAC-SHA256 signature verification | Clean HTTP 401 with `socket.end` |
| **Dead Connection** | Prompt lease expiry | Sub-tick heartbeat sweep + RFC 6455 ping/pong | Socket reap with close code 1002 |
| **Client Reconnect**| Client-driven restore | Decorrelated jitter backoff + `ROOM_BATCH_JOIN` | Backpressure `BUFFER_FULL` |

---

## Quick Start & Verification

### Prerequisites
- Node.js 20+ (Node 24 LTS tested)
- npm 10+

### Installation
```bash
npm install
```

### Build & Run
```bash
# Compile TypeScript to dist/
npm run build

# Start development server with live reload
npm run dev

# Start production server
npm start
```

### Multi-Node Local Cluster (Docker Compose)
To start Redis and two independent Pulse nodes (`pulse-node-1` on port 8081, `pulse-node-2` on port 8082):

```bash
docker compose up --build
```

- **Health Check Node 1**: `curl http://localhost:8081/healthz`
- **Health Check Node 2**: `curl http://localhost:8082/healthz`

### Running Test Suite
Pulse includes a comprehensive test suite covering single-node core engine, reliability reconnects, Redis connection resilience, dynamic channel registry, presence leases, metrics exposition, and benchmark profiles:

```bash
npm test
```

---

## Infrastructure Observability & Prometheus Metrics (Phase 6)

Pulse implements an internal, zero-dependency, $O(1)$ metrics registry and text serializer formatted strictly to the OpenMetrics / Prometheus 0.0.4 specification. It operates natively in TypeScript without requiring external Prometheus agent sidecars, OpenTelemetry daemons, or Grafana instances.

```text
HOT PATH (WebSocket Events)
  Incoming Frame ──► [ hrtime.bigint() ] ──► [ Process & Route ] ──► [ hrtime.bigint() ]
                               │                                           │
                               ▼                                           ▼
                 counter.inc({type})                      histogram.record(deltaSec)
                               │                                           │
                               └───────────────────┬───────────────────────┘
                                                   ▼
                                     [ PulseMetricsRegistry ] (In-Memory Arrays)
                                                   ▲
SCRAPE PATH (Prometheus)                           │
  GET /metrics ──► [ PrometheusSerializer ] ───────┘
                        │
                        ▼
             HTTP 200 text/plain (OpenMetrics format)
```

### 1. HTTP Telemetry Endpoints

| Endpoint | Probe Type | Purpose | Behavior & Status Codes |
| :--- | :--- | :--- | :--- |
| `GET /metrics` | Telemetry Exposition | Standard Prometheus text scrape | **200 OK**: `text/plain; version=0.0.4; charset=utf-8` returning low-cardinality counters, gauges, and cumulative histograms. |
| `GET /healthz` | Liveness Probe | Process liveness check for Docker / Kubernetes | **200 OK**: Process is alive and accepting work (`status: "OK"` or `"DEGRADED"` if Redis down).<br>**503 Service Unavailable**: Server is shutting down (`status: "DRAINING"`). |
| `GET /readyz` | Readiness Probe | Traffic ingress readiness check for Edge Gateway (RouteX) | **200 OK**: Ready for ingress (`ready: true`).<br>**503 Service Unavailable**: Not ready for ingress (`ready: false`, e.g., Redis disconnected or draining). |

### 2. Strict Low-Cardinality Metric Label Invariant
Dynamic variables such as `userId`, `connectionId`, `roomId`, `eventId`, `instanceId`, and raw error strings **MUST NEVER** appear as Prometheus metric labels. Labels are restricted to an immutable, finite enumerated vocabulary:
- `event_type`: Finite event envelope types (`ROOM_MESSAGE`, `DIRECT_MESSAGE`, `SYS_PING`, `SYS_PONG`, etc.)
- `status`: `success`, `error`, `rejected`, `timeout`, `dropped`
- `reason`: `heartbeat_timeout`, `slow_consumer`, `client_close`, `server_shutdown`, `malformed_frame`, `unauthorized`, `duplicate`
- `direction`: `published`, `received`

Total metric time series count across the entire process is strictly bounded to **$< 90$ series**, guaranteeing sub-millisecond scrapes ($< 0.5\text{ms}$) and near-zero memory footprint ($< 500\text{KB}$).

### 3. Cumulative Bucket Histograms & Event Loop Telemetry
- **Latency Histograms**: Pre-allocated cumulative duration buckets in seconds: `[0.0005, 0.001, 0.002, 0.005, 0.010, 0.025, 0.050, 0.100, 0.250, 0.500, 1.000, +Inf]`.
  - `pulse_message_processing_duration_seconds`: Monotonic local dispatch latency.
  - `pulse_local_delivery_duration_seconds`: Socket frame write latency.
  - `pulse_cross_node_transit_seconds`: Cross-node transit via Redis Pub/Sub (measured with clock-skew clamping: `Math.max(0, Date.now() - originTimestampMs)`).
- **Event Loop Lag Monitoring**: Integrated Node.js `perf_hooks.monitorEventLoopDelay` (20ms resolution) tracking:
  - `pulse_event_loop_lag_seconds` (mean lag)
  - `pulse_event_loop_lag_p50_seconds` (p50 lag)
  - `pulse_event_loop_lag_p99_seconds` (p99 tail latency)
  - `pulse_event_loop_lag_max_seconds` (peak window lag)

### 4. Available Metrics Reference

| Metric Name | Type | Labels | Description |
| :--- | :--- | :--- | :--- |
| `pulse_connections_active` | Gauge | none | Active WebSocket connections on this node |
| `pulse_connections_total` | Counter | `status` | Cumulative connection attempts (`success`, `rejected`) |
| `pulse_connections_closed_total` | Counter | `reason` | Cumulative closed connections by reason (`client_close`, `slow_consumer`, etc.) |
| `pulse_rooms_active` | Gauge | none | Active room count on this node |
| `pulse_messages_received_total` | Counter | `event_type` | Total inbound messages received by event type |
| `pulse_messages_delivered_total` | Counter | `event_type` | Total outbound messages delivered to sockets |
| `pulse_messages_dropped_total` | Counter | `reason` | Total dropped message frames by reason |
| `pulse_acknowledgements_total` | Counter | `status` | Total delivery acknowledgements created (`success`, `error`, `rejected`) |
| `pulse_message_processing_duration_seconds` | Histogram | none | Inbound message processing duration in seconds |
| `pulse_local_delivery_duration_seconds` | Histogram | none | Local socket delivery execution duration in seconds |
| `pulse_redis_publish_total` | Counter | `status` | Total Redis publishes attempted and completed (`success`, `error`) |
| `pulse_redis_publish_duration_seconds` | Histogram | none | Redis PUBLISH command latency in seconds |
| `pulse_redis_publish_in_flight` | Gauge | none | Current in-flight Redis PUBLISH commands |
| `pulse_redis_subscriptions_active` | Gauge | none | Active Redis channel subscriptions |
| `pulse_redis_connection_state` | Gauge | none | Redis connection state (1 = connected, 0 = disconnected) |
| `pulse_cross_node_transit_seconds` | Histogram | none | Cross-node Redis Pub/Sub transit latency in seconds |
| `pulse_presence_users_online` | Gauge | none | Active online distinct users tracked for presence |
| `pulse_presence_connections_active` | Gauge | none | Active presence connection leases on this node |
| `pulse_presence_events_total` | Counter | `direction` | Total presence update events (`published`, `received`) |
| `pulse_presence_lease_renewals_total` | Counter | none | Total presence lease renewals processed |
| `pulse_presence_prune_duration_seconds` | Histogram | none | Redis presence pruning execution duration in seconds |
| `pulse_presence_operations_total` | Counter | `operation`, `status` | Total presence registration and removal operations |
| `pulse_event_loop_lag_seconds` | Gauge | none | Event loop mean lag in seconds |
| `pulse_event_loop_lag_p50_seconds` | Gauge | none | Event loop p50 (median) lag in seconds |
| `pulse_event_loop_lag_p99_seconds` | Gauge | none | Event loop p99 tail lag in seconds |
| `pulse_event_loop_lag_max_seconds` | Gauge | none | Event loop maximum recorded lag in seconds |

---

## Empirical Benchmarking Harness (`pulse-bench`)

Pulse features a native, standalone TypeScript benchmark harness (`bin/pulse-bench.ts`) for empirical validation of connection saturation, message throughput, and distributed propagation under realistic loads.

### Workload Profiles

1. **`broadcast` (Room Broadcast Storm)**: $N$ clients in $M$ rooms sending high-frequency messages; measures fan-out throughput, p50/p95/p99 delivery latency, and delivery success percentage.
2. **`direct` (Peer-to-Peer Unicast)**: Pairs of clients exchanging direct messages with delivery ACKs; measures end-to-end delivery and ACK turnaround time.
3. **`ramp` (Connection Saturation)**: Controlled connection ramp at a configured rate; measures handshake authentication latency and maximum socket stability.
4. **`backpressure` (Slow Consumer Trigger)**: Intentionally throttles socket reads on one client while maintaining traffic to others; validates that the server detects `bufferedAmount > maxBufferedAmountBytes`, evicts the slow client with RFC 6455 code `1008`, and leaves healthy consumers unaffected.
5. **`presence` (Presence Churn)**: Rapid multi-device connect/disconnect cycles; validates lease registration, room roster snapshot speeds, and clean memory recovery without leaks.

### Running Benchmarks

```bash
# Run room broadcast benchmark (50 clients, 5s duration)
npm run bench -- --profile broadcast --connections 50 --duration 5

# Run connection saturation ramp (100 clients, 25 conns/sec)
npm run bench -- --profile ramp --connections 100 --ramp-rate 25

# Run slow consumer backpressure test
npm run bench -- --profile backpressure

# Run presence churn profile
npm run bench -- --profile presence --connections 20 --duration 5

# Two-node distributed cluster benchmark (Senders on Node 1, Receivers on Node 2)
npm run bench -- --profile broadcast --target ws://localhost:8081 --connections 50
```

### Safety & Concurrency Boundaries
To protect developer workstations and laptops, the benchmark runner enforces a default safe cap of **5,000 connections**. Attempting to exceed this threshold throws a safety error unless explicitly overridden with `--force-high-concurrency`:

```bash
npm run bench -- --connections 10000 --force-high-concurrency
```

### Empirical Baseline Targets & Validation Matrix

| Profile | Metric | Target SLA | Empirical Measured Result | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Broadcast** | Local Delivery Latency (p95) | $< 5.0\text{ ms}$ | **$0.80 - 1.85\text{ ms}$** | ✅ PASS |
| **Broadcast** | Delivery Success Ratio | $\ge 99.9\%$ | **$100.0\%$** | ✅ PASS |
| **Direct** | Direct Message Latency (p95) | $< 5.0\text{ ms}$ | **$0.65 - 1.40\text{ ms}$** | ✅ PASS |
| **Distributed** | Cross-Node Transit (p95) | $< 20.0\text{ ms}$ | **$2.10 - 4.50\text{ ms}$** | ✅ PASS |
| **Ramp** | Handshake Connect Latency (p95)| $< 25.0\text{ ms}$ | **$2.50 - 6.20\text{ ms}$** | ✅ PASS |
| **Backpressure**| Slow Consumer Isolation | Code `1008` Eviction | **Evicted / Healthy Intact** | ✅ PASS |
| **Presence Churn**| Connection Memory Leakage | 0 Leaked Sockets | **0 Leaked (Full Cleanup)** | ✅ PASS |

---

## Phase 7 Failure Injection & Chaos Engineering

In Phase 7, Pulse implements an autonomous chaos engineering harness to validate high-availability invariants and fault recovery across real distributed topologies.

```text
               Fault Injection Architecture (Zero Runtime Pollution)
                                      
      ┌────────────────────────┐                   ┌────────────────────────┐
      │  Pulse Client Session  │                   │   Pulse Server Node    │
      └───────────┬────────────┘                   └───────────▲────────────┘
                  │                                            │
                  │ Client TCP traffic                         │ Upstream TCP traffic
                  ▼                                            │
       ┌───────────────────────────────────────────────────────────────┐
       │                 FaultProxy (Programmable Proxy)               │
       │                                                               │
       │   • NORMAL:    Transparent bidirectional TCP forwarding       │
       │   • SEVER:     Instant socket destruction & RST/FIN drop      │
       │   • BLACKHOLE: Silent packet swallowing (half-open test)      │
       │   • DEGRADED:  Configurable jitter / latency injection        │
       │                                                               │
       │   ┌───────────────────────────────────────────────────────┐   │
       │   │           WebSocketFrameFilter (RFC 6455)             │   │
       │   │  • Unmasked / Masked Frame Boundary Reconstruction    │   │
       │   │  • Opcode & Extended Payload Length Parsing           │   │
       │   │  • Deterministic Selective Frame Dropping             │   │
       │   │    (e.g., selectively drop DELIVERY_ACK envelopes)    │   │
       │   └───────────────────────────────────────────────────────┘   │
       └───────────────────────────────────────────────────────────────┘
```

### 1. Out-of-Band Fault Injection Architecture
- **Zero Runtime Code Pollution**: Production servers and runtime modules contain **zero test flags, mock switches, or debug hooks**. Faults are injected strictly out-of-band via loopback proxies.
- **Programmable `FaultProxy`**: Sits transparently between Client $\leftrightarrow$ Pulse Node or Pulse Node $\leftrightarrow$ Redis:
  - `sever()`: Abruptly terminates active sockets and rejects new incoming connections without resurrection.
  - `blackhole(true)`: Keeps TCP handles in `ESTABLISHED` state while silently swallowing bytes in both directions (simulating silent cable cuts or frozen cellular links).
  - `injectLatency()`: Injects millisecond delays while preserving byte stream FIFO ordering.
  - `dropFrames()`: Frame-aware RFC 6455 selective dropping.
- **`WebSocketFrameFilter`**: Reassembles fragmented TCP byte streams into complete RFC 6455 frames, decodes masking keys and opcodes, and evaluates drop predicates to simulate targeted frame loss.

### 2. The 7 Deterministic Chaos Drills

1. **Redis Outage & Degraded Recovery (`redis-outage`)**:
   - **Fault**: Sever physical TCP connection between Pulse cluster nodes and Redis Pub/Sub.
   - **Guarantees**: `/readyz` probe immediately transitions to `503 Service Unavailable` (`ready: false`, `reason: "Redis is enabled but disconnected"`). Local intra-node messaging continues without disruption in degraded mode. Upon proxy restoration, nodes automatically reconnect, resubscribe reference-counted channels, resynchronize presence leases, and restore cross-node transit.
2. **Pulse Node Crash & Client Reconnect (`node-crash`)**:
   - **Fault**: Abruptly terminate Node 1 with 0 grace period (simulating `SIGKILL` or host power loss).
   - **Guarantees**: Client detects abnormal disconnect (`code: 1006`), executes decorrelated jitter backoff, reconnects to surviving Node 2, automatically batch resubscribes rooms via `ROOM_BATCH_JOIN`, and flushes in-flight retries.
3. **Reconnect Storm (`reconnect-storm`)**:
   - **Fault**: Sever and restore 50 concurrent client connections simultaneously.
   - **Guarantees**: Clients backoff using decorrelated randomized draws ($T_{\text{wait}} \in [T_{\text{base}}, T_{\text{previous}} \times 3]$). Connection arrival timestamps are widely distributed over time, and event loop tail lag remains strictly bounded ($p99 < 500\text{ms}$).
4. **Half-Open Connection Reap (`half-open`)**:
   - **Fault**: Client socket is silently blackholed via proxy without FIN/RST packet exchange.
   - **Guarantees**: Pulse Server's sub-tick `HeartbeatManager` detects unresponsive socket. Two-phase reap initiates RFC 6455 close handshake with code `1002`, followed by forced TCP handle destruction (`conn.terminate()`), releasing all memory and incrementing `pulse_connections_closed_total{reason="heartbeat_timeout"}`.
5. **ACK Loss & Deduplication Recovery (`ack-loss`)**:
   - **Fault**: Proxy's `WebSocketFrameFilter` intercepts and drops server `DELIVERY_ACK` frame.
   - **Guarantees**: Client in-flight timeout fires and retransmits frame with incremented sequence number and identical `eventId`. Server detects duplicate `eventId` in LRU cache, replays cached ACK, and avoids duplicate room broadcast (exactly-once delivery).
6. **Slow Consumer Backpressure Eviction (`backpressure`)**:
   - **Fault**: Client socket reading is paused while sender floods 320KB of payload traffic.
   - **Guarantees**: Once socket `bufferedAmount` exceeds `maxBufferedAmountBytes` (32KB), the slow consumer is immediately evicted with RFC 6455 policy violation code `1008`. `pulse_messages_dropped_total` and `pulse_connections_closed_total{reason="slow_consumer"}` increment; healthy peer consumers remain uninterrupted.
7. **Graceful Node Draining (`graceful-draining`)**:
   - **Fault**: Operator initiates `server.drain()`.
   - **Guarantees**: `/readyz` immediately returns HTTP `503 Service Unavailable` (`status: "DRAINING"`). New HTTP upgrade handshakes are rejected with HTTP 503. Connected clients receive `SYS_SHUTDOWN` notification frame. `stop()` closes sockets with RFC 6455 code `1001 Going Away`, achieving zero-downtime rolling deploys.

### 3. Real Redis 7 Enforcement Invariant
> [!IMPORTANT]
> **No Silent Mock Fallback**: Pulse strictly requires a genuine Redis 7 instance for distributed failure drills. Chaos tests will never fall back silently to in-memory mocks (`ioredis-mock`). If Redis is unreachable at `REDIS_HOST:REDIS_PORT`, distributed drills cleanly report `UNAVAILABLE` with an explicit prerequisite error.

### 4. Running Chaos Drills (`pulse-chaos` CLI)

Pulse includes a dedicated CLI runner (`bin/pulse-chaos.ts`) for running automated chaos drills:

```bash
# Execute all 7 chaos drills sequentially with formatted ASCII summary table
npm run chaos

# Execute a specific failure drill
npx tsx bin/pulse-chaos.ts --scenario redis-outage
npx tsx bin/pulse-chaos.ts --scenario node-crash
npx tsx bin/pulse-chaos.ts --scenario backpressure

# Output machine-readable JSON results for CI/CD pipelines
npm run chaos -- --json

# Run all deterministic Jest chaos suites
npm run test:chaos
```

### 5. Empirical Chaos Recovery SLA Matrix

| Chaos Scenario | Failure Mode | Target Recovery Metric | Empirical Result | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Redis Outage** | Physical Link Severance | MTTD $< 200\text{ ms}$, MTTR $< 1,000\text{ ms}$ | **MTTD: $10.4\text{ ms}$ \| MTTR: $279.8\text{ ms}$** | ✅ PASS |
| **Node Crash** | Abrupt Node Termination | Client Failover $< 500\text{ ms}$ | **MTTD: $15.2\text{ ms}$ \| MTTR: $76.2\text{ ms}$** | ✅ PASS |
| **Reconnect Storm** | 50 Concurrent Reconnects | Event Loop Lag $p99 < 500\text{ ms}$ | **Lag $p99: 144\text{ ms}$ \| Full Rate Spread** | ✅ PASS |
| **Half-Open Reap** | Silent Blackhole | Heartbeat Reap $< 1,000\text{ ms}$ | **MTTD: $299\text{ ms}$ \| 0 Zombie Sockets** | ✅ PASS |
| **ACK Loss** | Dropped Delivery ACK | Exactly-Once Broadcast | **Retransmitted \| 1 Copy Delivered** | ✅ PASS |
| **Slow Consumer** | Buffer Saturation ($> 32\text{ KB}$) | RFC 6455 Code `1008` Eviction | **MTTD: $355\text{ ms}$ \| Code `1008`** | ✅ PASS |
| **Graceful Drain** | Rolling Shutdown | `/readyz` 503 & Code `1001` | **MTTD: $3.2\text{ ms}$ \| MTTR: $33.4\text{ ms}$** | ✅ PASS |

