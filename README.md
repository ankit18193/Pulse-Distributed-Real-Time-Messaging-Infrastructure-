# Pulse — Distributed Real-Time Messaging Infrastructure

A production-oriented real-time messaging engine built with WebSockets, structured event distribution, and horizontal scaling patterns. Designed to demonstrate persistent connection ownership, room-based broadcast, presence, acknowledgements, heartbeats, reconnection, and fault-tolerant distributed communication with RouteX integrated as the edge gateway.

---

## Current Status: Phase 1 Complete (Single-Node Realtime Engine)

| Phase | Milestone | Status | Description |
| :--- | :--- | :--- | :--- |
| **Phase 0** | **Foundation & Architecture Lock** | ✅ Done | Project specification (`PULSE_PROJECT_SPEC.md`), `.gitignore`, GStack Antigravity workflows. |
| **Phase 1** | **Single-Node Realtime Engine** | ✅ Done | Core WebSocket server, token authentication, connection tracking, rooms, messaging, ACKs, heartbeats, graceful shutdown. |
| **Phase 2** | **Reliability & Connection Recovery** | ⏳ Planned | Reconnect storms, idempotency deduplication, client backoff jitter, ACK retry queues. |
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

## Phase 1 Architecture: Single-Node Engine

In Phase 1, Pulse implements a pure single-node real-time engine with zero distributed or database dependencies:

```text
       Client A               Client B               Client C
          │                      │                      │
          │ RFC 6455             │ RFC 6455             │ RFC 6455
          ▼                      ▼                      ▼
┌───────────────────────────────────────────────────────────────┐
│                     Pulse Realtime Engine                     │
│                                                               │
│   ┌───────────────────────────────────────────────────────┐   │
│   │                 Authenticator Engine                  │   │
│   │  • Handshake Token Validation (HMAC-SHA256)           │   │
│   │  • HTTP 401 Rejection / Identity Binding              │   │
│   └───────────────────────────────────────────────────────┘   │
│                                                               │
│   ┌─────────────────────┐           ┌─────────────────────┐   │
│   │  ConnectionManager  │           │     RoomManager     │   │
│   │  • Socket registry  │           │  • Room membership  │   │
│   │  • Multi-conn/user  │           │  • Automatic prune  │   │
│   └──────────┬──────────┘           └──────────┬──────────┘   │
│              │                                 │              │
│   ┌──────────┴─────────────────────────────────┴──────────┐   │
│   │                   MessageDispatcher                   │   │
│   │  • Event Schema Validation & Envelope Normalization   │   │
│   │  • Room Broadcast (no echo) & Direct Messaging        │   │
│   │  • Delivery Acknowledgements (DELIVERY_ACK)           │   │
│   └──────────────────────────┬────────────────────────────┘   │
│                              │                                │
│   ┌──────────────────────────┴────────────────────────────┐   │
│   │                   HeartbeatManager                    │   │
│   │  • Periodic SYS_PING Emission                         │   │
│   │  • Dead Connection Detection & Safe Reaping           │   │
│   └───────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────┘
```

---

## Standard Event Envelope

All client-to-server and server-to-client frames strictly adhere to the Pulse Event Envelope contract:

```json
{
  "eventId": "c7a8b3e1-4567-4f8a-9e12-3456789abcde",
  "type": "ROOM_MESSAGE",
  "timestamp": 1725280000000,
  "senderId": "alice",
  "target": {
    "roomId": "engineering"
  },
  "payload": {
    "text": "Hello engineering team!"
  },
  "correlationId": "client-req-001",
  "ackRequired": true
}
```

### Core Event Types
- `SYS_CONNECT_ACK`: Dispatched by server immediately upon successful handshake authentication.
- `SYS_PING` / `SYS_PONG`: Liveness checks between client and server.
- `SYS_ERROR`: Structured error returned when an event is invalid or unauthorized.
- `SYS_SHUTDOWN`: Broadcast to active connections when the server initiates graceful shutdown.
- `ROOM_JOIN` / `ROOM_JOIN_ACK`: Room subscription request and acknowledgement.
- `ROOM_LEAVE` / `ROOM_LEAVE_ACK`: Room unsubscribe request and acknowledgement.
- `ROOM_MESSAGE`: Broadcast to all members in a room (excluding sender).
- `DIRECT_MESSAGE`: Targeted delivery to all active connections belonging to `recipientId`.
- `DELIVERY_ACK`: Server-to-client acknowledgement confirming event processing.

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
Pulse includes 37 deterministic unit, integration, and end-to-end acceptance tests:

```bash
npm test
```
