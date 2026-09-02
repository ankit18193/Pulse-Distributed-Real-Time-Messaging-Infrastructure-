# Pulse — Distributed Real-Time Messaging Infrastructure

A production-oriented real-time messaging engine built with WebSockets, structured event distribution, and horizontal scaling patterns. Designed to demonstrate persistent connection ownership, room-based broadcast, presence, acknowledgements, heartbeats, reconnection, and fault-tolerant distributed communication with RouteX integrated as the edge gateway.

---

## Current Status: Phase 2 Complete (Reliability & Connection Management)

| Phase | Milestone | Status | Description |
| :--- | :--- | :--- | :--- |
| **Phase 0** | **Foundation & Architecture Lock** | ✅ Done | Project specification (`PULSE_PROJECT_SPEC.md`), `.gitignore`, GStack Antigravity workflows. |
| **Phase 1** | **Single-Node Realtime Engine** | ✅ Done | Core WebSocket server, token authentication, connection tracking, rooms, messaging, ACKs, heartbeats, graceful shutdown. |
| **Phase 2** | **Reliability & Connection Recovery** | ✅ Done | UUIDv7 event IDs, LRU idempotency cache, batch room resubscription, decorrelated jitter backoff, in-flight retry queue, sequence tracking, native ping/pong hooks. |
| **Phase 3** | **Multi-Node Pulse Topology** | ⏳ Planned | Multi-instance setup, connection ownership boundaries, local-vs-remote dilemma. |
| **Phase 4** | **Redis Pub/Sub Event Mesh** | ⏳ Planned | Cross-instance event distribution, Redis pub/sub channel routing. |
| **Phase 5** | **Distributed Presence Engine** | ⏳ Planned | Ephemeral presence registry, heartbeat leases, multi-device aggregation. |
| **Phase 6** | **Observability & Benchmarking** | ⏳ Planned | Prometheus metrics, latency tracking, empirical high-concurrency load testing. |
| **Phase 7** | **Failure & Resilience Engineering** | ⏳ Planned | Chaos testing, node crash simulation, split-brain isolation, graceful degradation. |
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

### Running Test Suite
Pulse includes 66 deterministic unit, integration, and end-to-end acceptance tests across 17 test suites:

```bash
npm test
```
