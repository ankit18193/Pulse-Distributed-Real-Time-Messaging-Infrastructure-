# Pulse — Distributed Real-Time Messaging Infrastructure
## System Specification, Architectural Foundation & Engineering Roadmap

> **Status**: APPROVED ARCHITECTURAL SPECIFICATION & PROJECT NORTH STAR
> **Version**: 1.0.0-draft
> **Author**: Antigravity Engineering & Garry Tan GStack Workflow
> **Classification**: Distributed Systems / Real-Time Infrastructure / Backend Infrastructure
> **Repository Root**: `PULSE_PROJECT_SPEC.md`

---

## Table of Contents

1. [Project Identity & Core Mission](#1-project-identity--core-mission)
2. [The Core Problem: From Request-Response to Distributed Realtime](#2-the-core-problem-from-request-response-to-distributed-realtime)
3. [The Core Solution: Shared Event Bus & Connection Ownership](#3-the-core-solution-shared-event-bus--connection-ownership)
4. [High-Level Architectural Evolution](#4-high-level-architectural-evolution)
5. [The RouteX Edge Gateway Relationship](#5-the-routex-edge-gateway-relationship)
6. [RouteX WebSocket Protocol Extension Strategy](#6-routex-websocket-protocol-extension-strategy)
7. [Pulse Core Responsibilities Breakdown](#7-pulse-core-responsibilities-breakdown)
8. [Distributed Systems Foundations & Engineering Concepts](#8-distributed-systems-foundations--engineering-concepts)
9. [Load Balancing, Connection Affinity & Sticky Sessions](#9-load-balancing-connection-affinity--sticky-sessions)
10. [Authentication & Authorization Model](#10-authentication--authorization-model)
11. [Event Envelope Specification & Message Protocols](#11-event-envelope-specification--message-protocols)
12. [Message Delivery Semantics & Reliability Guarantees](#12-message-delivery-semantics--reliability-guarantees)
13. [Redis Architecture: Event Bus vs. Ephemeral State](#13-redis-architecture-event-bus-vs-ephemeral-state)
14. [Persistent Storage & Database Boundary](#14-persistent-storage--database-boundary)
15. [Demonstration Client Application](#15-demonstration-client-application)
16. [Infrastructure Telemetry & Live Dashboard](#16-infrastructure-telemetry--live-dashboard)
17. [Fault Injection & Failure Simulation Architecture](#17-fault-injection--failure-simulation-architecture)
18. [Observability, Telemetry & Structured Logging](#18-observability-telemetry--structured-logging)
19. [Performance Targets & Empirical Benchmarking](#19-performance-targets--empirical-benchmarking)
20. [Multi-Tier Verification & Testing Strategy](#20-multi-tier-verification--testing-strategy)
21. [Security Posture & Abuse Prevention](#21-security-posture--abuse-prevention)
22. [Project Scope Boundaries: In-Scope vs. Explicitly Out-of-Scope](#22-project-scope-boundaries-in-scope-vs-explicitly-out-of-scope)
23. [Technology Direction & Stack Evaluation](#23-technology-direction--stack-evaluation)
24. [GStack Methodology: Isolation of Dev Workflow vs. Production Runtime](#24-gstack-methodology-isolation-of-dev-workflow-vs-production-runtime)
25. [Core Engineering Principles & Philosophy](#25-core-engineering-principles--philosophy)
26. [Phased Implementation Roadmap (Phases 0 through 12)](#26-phased-implementation-roadmap-phases-0-through-12)
27. [Phase Governance & Completion Rules](#27-phase-governance--completion-rules)
28. [Architectural Drift Prevention & Change Protocol](#28-architectural-drift-prevention--change-protocol)
29. [Complete Project Acceptance Criteria](#29-complete-project-acceptance-criteria)
30. [Technical Interview & System Architecture Narrative](#30-technical-interview--system-architecture-narrative)
31. [Complexity Defense: Anti-Overbuilding Manifesto](#31-complexity-defense-anti-overbuilding-manifesto)
32. [Final Project Vision & Architectural Summary](#32-final-project-vision--architectural-summary)

---

## 1. Project Identity & Core Mission

### 1.1 Formal Naming & Taxonomy
- **Project Name**: Pulse
- **Full Formal Title**: Pulse — Distributed Real-Time Messaging Infrastructure
- **Classification**: Distributed Systems / Real-Time Infrastructure / Backend Infrastructure

### 1.2 The Primary Purpose
The primary purpose of Pulse is to engineer a production-oriented distributed real-time messaging infrastructure. It is designed to demonstrate how persistent transport connections, horizontal multi-instance scaling, inter-node event distribution, distributed presence synchronization, transport reliability protocols, and infrastructure-level observability operate coherently under load.

### 1.3 The Fundamental Distinction: Infrastructure vs. Application
> [!IMPORTANT]
> **Pulse is NOT a "chat application".**
> The chat interface that will be constructed in later phases is exclusively a demonstration client and testing harness. Its sole reason for existence is to provide visual feedback, exercise the underlying transport protocols, simulate client drops, and inspect live distributed behavior.
>
> **The real product is the underlying real-time engine, distributed event coordination bus, and resilient connection management layer.** Every architectural decision, performance metric, and design review must be evaluated through the lens of infrastructure reliability, not client-side application convenience.

---

## 2. The Core Problem: From Request-Response to Distributed Realtime

### 2.1 The Limits of Traditional Request-Response (HTTP/1.1 & HTTP/2)
Modern interactive applications require sub-second state synchronization. Under traditional HTTP semantics:

```
┌──────────┐                     ┌──────────┐
│  Client  │ ─── HTTP Request ─> │  Server  │
│          │ <── HTTP Response ─ │          │
└──────────┘                     └──────────┘
```

This model fundamentally breaks down when requirements demand:
- **Instant Event Propagation**: Downstream data must reach clients without client-initiated polling.
- **Bi-directional Low Latency**: Transport overhead (TCP handshakes, TLS negotiation, 1KB+ HTTP request headers) must not accompany every small event payload (e.g., typing indicators, coordinate ticks, cursor movements).
- **Persistent State Awareness**: The server must know the exact instantaneous reachability status of each connected client.

Techniques such as short-polling exhaust thread pools and flood infrastructure with empty `304 Not Modified` responses. Long-polling and Server-Sent Events (SSE) alleviate downstream delivery but remain half-duplex, requiring auxiliary HTTP POST requests for upstream client-to-server messaging that serialize over separate network flows.

### 2.2 Full-Duplex Persistent Transports (WebSockets)
WebSockets solve half-duplex latency by establishing a single long-lived TCP connection initiated via an HTTP `101 Switching Protocols` handshake:

```
┌──────────┐                                      ┌──────────┐
│  Client  │ ─── HTTP Upgrade: websocket ───────> │  Server  │
│          │ <── HTTP 101 Switching Protocols ─── │          │
│          │ <==================================> │          │
│          │   Persistent Bidirectional Frames   │          │
└──────────┘                                      └──────────┘
```

Once established, transport overhead collapses to tiny frame headers (2 to 10 bytes), enabling sub-millisecond full-duplex delivery.

### 2.3 The Central Distributed Real-Time Problem: State-Bound Sockets
While WebSockets solve single-server bidirectional transport, they introduce a fundamental distributed systems dilemma: **WebSockets are stateful, memory-bound TCP connections pinned to an operating system file descriptor on a specific physical or virtual machine.**

Consider two users connected across an auto-scaled fleet:

```
┌──────────┐                                      ┌──────────┐
│  User A  │ ────────── WebSocket Link ─────────> │ Server A │
└──────────┘                                      └──────────┘
                                                       │
                                              ??? No Direct Route ???
                                                       │
┌──────────┐                                      ┌──────────┐
│  User B  │ ────────── WebSocket Link ─────────> │ Server B │
└──────────┘                                      └──────────┘
```

1. **Connection Locality**: User A connects to `Server A`. User B connects to `Server B`.
2. **Channel Blindness**: When User A emits a message targeted to Room `alpha` (which User B belongs to), `Server A` only holds socket descriptors for clients connected directly to `Server A`.
3. **Information Partition**: `Server A` has no native socket-level awareness of `Server B`’s connected clients. Without an inter-server coordination layer, `Server A` cannot deliver the frame to User B.
4. **Failure Blast Radius**: If `Server A` crashes, all of its local connections terminate instantly. Neighboring instances have no native way of distinguishing between a client disconnecting intentionally versus an entire host crashing.

Solving this multi-node connection coordination problem in a robust, horizontally scalable, and observable manner is the core problem Pulse solves.

---

## 3. The Core Solution: Shared Event Bus & Connection Ownership

### 3.1 Architectural Paradigm: Decoupled Socket Ownership & Event Distribution
Pulse resolves the distributed state problem by establishing a clear separation between **Connection Ownership** and **Event Propagation**:

```
 ┌──────────┐                                                      ┌──────────┐
 │  User A  │                                                      │  User B  │
 └────┬─────┘                                                      └────▲─────┘
      │ WebSocket Frame                                                 │ WebSocket Frame
      ▼                                                                 │
┌───────────┐                 ┌───────────────┐                   ┌─────┴─────┐
│  Pulse A  │ ── PUBLISH ───> │ Redis Pub/Sub │ ── SUBSCRIBE ───> │  Pulse B  │
│ (Node 1)  │                 │  (Event Bus)  │                   │ (Node 2)  │
└───────────┘                 └───────────────┘                   └───────────┘
```

### 3.2 Core Architectural Pillars
1. **Connection Ownership**:
   - Each Pulse instance owns *only* its locally attached client sockets.
   - Socket references remain purely local in memory (file descriptors / socket handles).
   - No cross-server memory sharing or distributed locks are maintained across the socket layer.
2. **Shared Event Distribution (Redis Pub/Sub)**:
   - When a Pulse node receives an inbound event destined for a logical room or user, it translates the local frame into a standardized, serialized Event Envelope and publishes it to a shared Redis Pub/Sub channel.
   - All Pulse instances subscribed to that logical channel receive the event payload via Redis.
3. **Local Dispatch & Fan-Out**:
   - Upon receiving an event from Redis, each Pulse instance inspects its local room registry.
   - If local clients belong to the target room, the instance serializes the event into WebSocket frames and pushes them down its local socket handles.
   - If an instance has no local subscribers for that room, it drops the event with zero CPU-intensive processing.
4. **Distributed Presence**:
   - Node-level heartbeats and connection state updates propagate across shared Redis data structures.
   - When User A disconnects from `Pulse A`, an unbind event broadcasts to the fleet, allowing `Pulse B` to update its local view of User A's presence in real time.
5. **Role of Redis**:
   - **Redis is NOT a simple database cache in Pulse.**
   - In Pulse, Redis is a mission-critical piece of the **realtime coordination and distributed message distribution fabric**.

---

## 4. High-Level Architectural Evolution

The Pulse architecture is designed to evolve in strictly gated phases to prevent premature optimization and unearned complexity.

### 4.1 Phase A: Standalone Realtime Engine (Independent Foundation)
In this initial conceptual architecture, Pulse is verified as a completely self-sufficient, distributed-ready system without any edge proxies:

```
                            CLIENT APPLICATIONS
                                │        │
                       WebSocket│        │WebSocket
                                ▼        ▼
                      ┌───────────┐    ┌───────────┐
                      │  Pulse A  │    │  Pulse B  │
                      └─────┬─────┘    └─────┬─────┘
                            │                │
                      PUBLISH / SUBSCRIBE    │
                            │                │
                            ▼                ▼
                      ┌────────────────────────────┐
                      │       Redis Pub/Sub        │
                      │        (Event Bus)         │
                      └────────────────────────────┘
```

### 4.2 Phase B: Unified Edge-Integrated Infrastructure (With RouteX)
Once Pulse’s distributed routing, presence, and failure recovery are empirically proven, the RouteX edge gateway is integrated as the front door:

```
                                  INTERNET
                                      │
                                      ▼
                            ┌───────────────────┐
                            │      RouteX       │
                            │   Edge Gateway    │
                            │ (Reverse Proxy,   │
                            │  WSS Upgrade,     │
                            │  Rate Limiting,   │
                            │  Auth Validation) │
                            └─────────┬─────────┘
                                      │
                         Internal HTTP / WebSocket
                                      │
                  ┌───────────────────┴───────────────────┐
                  ▼                                       ▼
          ┌───────────────┐                       ┌───────────────┐
          │ Pulse Node A  │                       │ Pulse Node B  │
          │ (Realtime WS) │                       │ (Realtime WS) │
          └───────┬───────┘                       └───────┬───────┘
                  │                                       │
                  │         Shared Event Fabric           │
                  └───────────────┬───────────────────────┘
                                  ▼
                    ┌───────────────────────────┐
                    │       Redis Pub/Sub       │
                    │        (Event Bus)        │
                    └─────────────┬─────────────┘
                                  │
                                  ▼
                    ┌───────────────────────────┐
                    │    Persistent Database    │
                    │ (Durable History/Records) │
                    └───────────────────────────┘
```

---

## 5. The RouteX Edge Gateway Relationship

### 5.1 Clear Division of Responsibilities
To ensure tight separation of concerns, the system enforces a strict division of labor across infrastructure components:

| Responsibility Domain | Owned by RouteX (Edge Layer) | Owned by Pulse (Realtime Core) | Owned by Redis (Event Fabric) | Owned by Database (Persistence) |
| :--- | :---: | :---: | :---: | :---: |
| **Public TLS Termination** | **Yes** | No | No | No |
| **HTTP Routing & Ingress** | **Yes** | No | No | No |
| **Edge Rate Limiting** | **Yes** (IP/Token) | No (Internal backpressure only) | No | No |
| **Edge Security Headers** | **Yes** | No | No | No |
| **WSS Protocol Upgrade** | **Yes** (Handshake Proxy) | Consumes upgraded socket | No | No |
| **WebSocket Frame Handling**| No | **Yes** | No | No |
| **Room State & Subscriptions**| No | **Yes** (Local sets) | No | No |
| **Direct & Room Messaging** | No | **Yes** | Routes across nodes | No |
| **Client Heartbeats & ACKs**| No | **Yes** | No | No |
| **Reconnection Orchestration**| No | **Yes** | No | No |
| **Fleet Event Distribution**| No | Publishes/Subscribes | **Yes** (Pub/Sub) | No |
| **Ephemeral Presence** | No | Tracks local | **Yes** (TTL hashes/sets) | No |
| **Durable History & Audit** | No | Dispatches write tasks | No | **Yes** (PostgreSQL) |

### 5.2 Mandatory Architectural Independence Rule
> [!CAUTION]
> **Pulse MUST be architecturally complete, functional, testable, and demonstrable WITHOUT RouteX.**
>
> Under no circumstances may Pulse source code import, reference, or depend upon RouteX binaries, configuration files, or internal gateway logic. RouteX is an upstream edge gateway that routes traffic into Pulse; Pulse is a downstream backend service.
>
> **The implementation sequence is invariant:**
> 1. Single-Node Pulse $\rightarrow$
> 2. Distributed Multi-Node Pulse $\rightarrow$
> 3. Redis Pub/Sub Event Mesh $\rightarrow$
> 4. Resilience & Observability Verification $\rightarrow$
> 5. **Only then: RouteX Edge Gateway Integration.**

---

## 6. RouteX WebSocket Protocol Extension Strategy

### 6.1 Assessment of Current State
RouteX was initially engineered as an HTTP/1.1 and HTTP/2 reverse proxy and edge gateway. It possesses robust mechanisms for header sanitization, IP filtering, authentication forwarding, rate limiting, and HTTP request routing.

However, standard HTTP reverse proxies do not automatically support full-duplex WebSocket connections. WebSockets require:
1. Intercepting the client's HTTP request containing `Upgrade: websocket` and `Connection: Upgrade`.
2. Validating the `Sec-WebSocket-Key` and `Sec-WebSocket-Version`.
3. Establishing an upstream TCP socket to a downstream Pulse node.
4. Relaying the `101 Switching Protocols` handshake response from Pulse back to the client.
5. Severing standard HTTP request-response timeouts and establishing a persistent, bidirectional byte pipe (TCP tunneling) between client and upstream Pulse instance.

### 6.2 The Extension Mandate: Extend RouteX, Do Not Replace It
During the designated RouteX integration phase (Phase 8), RouteX will be inspected. If RouteX lacks native, production-grade WebSocket upgrade and bi-directional TCP proxying:

- **We will EXTEND RouteX directly.**
- We will **NOT** deploy NGINX, Envoy, HAProxy, or Traefik as an ad-hoc secondary proxy.
- We will **NOT** bypass RouteX to hide gateway limitations.
- Extending RouteX proves that our previously built edge gateway is an extensible, modular infrastructure asset capable of scaling into real-time transports.

---

## 7. Pulse Core Responsibilities Breakdown

Pulse’s real-time engine is structured into nine core operational modules:

### A. Connection Management
- **Handshake Negotiation**: Validates transport parameters, extracts authorization tokens from query parameters or headers, and accepts or rejects the handshake before upgrading.
- **Connection Identity**: Generates a cryptographically strong `connectionId` unique across the cluster, bound to the authenticated `userId`.
- **Socket Lifecycle State Machine**: Tracks socket states: `CONNECTING`, `AUTHENTICATED`, `ACTIVE`, `DEGRADED` (missing pings), `DISCONNECTING`, `TERMINATED`.
- **Resource Cleanup**: Guarantees file descriptors, timer loops, and memory buffers are freed upon socket closure.
- **Graceful Fleet Shutdown**: On `SIGTERM`/`SIGINT`, stops accepting new upgrades, sends `499/1001 Going Away` frames to clients with jittered reconnect advisories, drains in-flight message queues, and cleanly exits.

### B. Rooms (Logical Partitioning)
- **Dynamic Membership**: Allows clients to join and leave logical namespaces (rooms) at runtime.
- **Local Registry**: Maintains local bidirectional lookup maps (`roomId -> Set<connectionId>` and `connectionId -> Set<roomId>`).
- **Broadcast Execution**: Delivers a single inbound event to all locally subscribed connections in `O(N)` local time where `N` is local room subscribers.
- **Room Lifecycle**: Automatically cleans up ephemeral room state in local memory when the subscriber count drops to zero.

### C. Messaging & Envelope Dispatch
- **Direct Messaging (Peer-to-Peer)**: Routes private events targeting a specific `userId` across the fleet.
- **Room Broadcast (Pub/Sub)**: Routes events targeting a `roomId` to all instances hosting active participants.
- **Standardized Serialization**: Enforces JSON/Binary encoding constraints and validates message size bounds.

### D. Presence Engine
- **State Coherence**: Tracks client status across states: `ONLINE`, `IDLE`, `OFFLINE`.
- **Multi-Device Support**: A user may hold multiple active sockets (e.g., mobile + desktop). A user transitions to `OFFLINE` only when their last active socket terminates.
- **Presence Heartbeats**: Periodically refreshes presence keys in Redis with strict Time-To-Live (TTL) expiries to prevent "zombie" online statuses if a server abruptly loses power.

### E. Heartbeats & Liveness Detection
- **Bi-Directional Probing**: Emits ping frames from server to client every $T_{\text{ping}}$ seconds (e.g., 30s).
- **Dead Connection Reaper**: Expects a pong response within $T_{\text{pong}}$ seconds (e.g., 10s). Sockets that fail to pong within the deadline are terminated aggressively to reclaim OS file descriptors.
- **Half-Open TCP Detection**: Detects silent connection drops (e.g., client WiFi dropping without emitting a TCP `FIN`/`RST`).

### F. Delivery Acknowledgements (ACKs)
- **Client-to-Server ACKs**: Client receives a message and emits an acknowledgement frame containing the `eventId` to confirm local presentation.
- **Server-to-Client ACKs**: Pulse confirms receipt and successful Redis publication back to the publishing client.
- **ACK Tracking**: Tracks unacknowledged events in local memory buffers with exponential backoff timers before triggering client-side retry alarms.

### G. Reconnection & Session Recovery
- **Disconnection Detection**: Quickly classifies whether an interruption was network-induced or intentional.
- **Exponential Jitter Backoff**: Prevents thundering herds by advising clients to reconnect with randomized exponential backoff ($T_{\text{wait}} = \min(M, B \times 2^{\text{attempt}}) \pm \text{jitter}$).
- **Session Re-establishment**: Upon reconnect, validates authentication, restores prior room subscriptions, and resumes event stream processing.

### H. Event Distribution Fabric
- **Channel Partitioning**: Routes room events to dedicated Redis Pub/Sub channels to avoid hot-spotting a single global channel.
- **Inter-Instance Deserialization**: Listens to Redis channels on a dedicated background subscriber thread/loop, decoding event envelopes and handing them to the local dispatch engine.

### I. Transport Reliability
- **Idempotency Keys**: Attaches unique UUIDv7 / ULIDs to every event to allow consumers to detect and discard duplicate deliveries.
- **Local Ordering Guardrails**: Preserves per-connection chronological sequence numbers.
- **Backpressure Protection**: Monitors socket write buffer watermarks; pauses reads or sheds non-essential events if a slow client’s buffer expands beyond safe memory limits.

---

## 8. Distributed Systems Foundations & Engineering Concepts

Pulse is explicitly engineered as a portfolio-grade demonstration of core distributed systems concepts. The following table documents why each concept matters specifically to Pulse:

| Concept | Concrete Manifestation in Pulse | Why It Matters to Pulse |
| :--- | :--- | :--- |
| **Horizontal Scaling** | Running $N$ identical stateless Pulse server nodes behind a load balancer. | Proves that capacity is not bounded by single-box RAM/CPU limits. Adding instances linearly expands connection capacity. |
| **Stateless vs. Stateful** | Pulse instances are transport-stateful (memory-bound TCP sockets) but application-stateless (no durable data stored on disk). | Highlights the classic architectural challenge: how to scale a system whose connections are fundamentally stateful. |
| **Connection Ownership** | Socket file descriptors are exclusively held in the RAM of the node that accepted the TCP connection. | Prevents naive anti-patterns like attempting to serialize socket descriptors or using distributed locking across connections. |
| **Distributed Pub/Sub** | Decoupling event publishers from event consumers via Redis channels. | Enables any node to broadcast an event without knowing which other nodes host subscribers or where they reside. |
| **Eventual Consistency** | Presence updates and room member counts converge across the fleet over milliseconds rather than via blocking distributed transactions. | Eliminates cross-cluster locking overhead; ensures system remains available even under temporary inter-node transmission delays. |
| **Message Ordering** | Guaranteeing causal and chronological ordering per sender via monotonically increasing sequence IDs. | In distributed topologies, network packet interleaving can cause Event 2 to arrive before Event 1; Pulse must handle sequence validation. |
| **At-Least-Once Delivery** | Retrying unacknowledged frames until confirmed, accepting potential duplicates. | Prevents silent message drops across noisy wireless links, shifting the responsibility of deduplication to idempotent event IDs. |
| **Idempotency** | Attaching unique `eventId` tags to all frames and caching recently processed IDs. | Guarantees that client retries or network replays do not duplicate financial ticks, messages, or state mutations. |
| **Liveness Probing** | Regular ping/pong health frames coupled with deadline timers. | Prevents memory leakage and phantom connection accumulation caused by silent TCP half-open socket failures. |
| **Graceful Shutdown** | Intercepting termination signals (`SIGTERM`), unregistering from presence, draining frames, and instructing clients to reconnect. | Prevents abrupt client drops and socket errors during rolling zero-downtime infrastructure deployments. |
| **Socket Backpressure** | Monitoring kernel socket send buffers and pausing ingestion when clients cannot consume frames fast enough. | Prevents a single slow 3G mobile client from consuming gigabytes of server memory and crashing an entire Pulse instance. |
| **Thundering Herd / Reconnect Storms** | Enforcing randomized client-side jitter on reconnects. | Prevents 50,000 disconnected clients from simultaneously hammering the edge gateway when a server instance reboots. |
| **Ephemeral vs. Durable State**| Redis stores ephemeral presence and event distribution; SQL stores persistent user identities and durable chat history. | Ensures the system does not abuse memory stores for long-term data, nor abuse relational databases for high-frequency transient state. |
| **Fault Isolation** | The failure or crash of Node A terminates only Node A’s local sockets; Nodes B and C continue uninterrupted. | Proves high availability: single-node failure blast radius is strictly contained. |

---

## 9. Load Balancing, Connection Affinity & Sticky Sessions

### 9.1 The Long-Lived Connection Dilemma
In traditional HTTP stateless routing, every request is independently load-balanced using Round Robin or Least Connections. In WebSocket architectures, the initial HTTP upgrade request selects a server, and **that specific server owns the persistent TCP stream for minutes, hours, or days.**

```
Client 1 ───┐
Client 2 ───┼──> [ Edge Load Balancer ] ──> Pulse Instance A (Holds Socket 1, Socket 2)
Client 3 ───┘                            ──> Pulse Instance B (Holds Socket 3)
```

### 9.2 Sticky Sessions (Session Affinity): Trade-Off Analysis
During implementation planning, Pulse will evaluate two distinct ingress strategies:

1. **Standard Layer 4 (TCP) / Layer 7 (Least Connection) Balancing**:
   - The load balancer routes the initial upgrade handshake to the least loaded Pulse node.
   - Once upgraded, that node holds the connection.
   - **Advantage**: Simpler edge routing; connections naturally distribute evenly across the fleet.
   - **Requirement**: The inter-node event bus (Redis) must be 100% reliable, because a client reconnecting may land on a completely different server.
2. **Layer 7 Cookie/IP Affinity (Sticky Sessions)**:
   - The load balancer uses an affinity cookie or client IP hash to attempt to reconnect a dropped client back to the same Pulse instance.
   - **Advantage**: May reduce cross-node handoffs if an instance retains local session memory.
   - **Disadvantage**: Causes severe connection imbalance (hot spotting); fails completely when an instance crashes (which is precisely when reconnects occur).

### 9.3 Architectural Decision
> [!IMPORTANT]
> **Pulse is architected under the assumption of ZERO REQUIRED SESSION AFFINITY.**
> Redis Pub/Sub makes sticky sessions completely unnecessary for message routing. When a client reconnects and lands on *any* healthy Pulse instance, that instance simply subscribes to the client's channels in Redis, immediately restoring full bidirectional communication. Sticky sessions will only be evaluated as an optional optimization, never as a functional dependency.

---

## 10. Authentication & Authorization Model

### 10.1 Handshake-Phase Authentication
Pulse enforces authentication **before** upgrading a connection to full real-time transport:

```
┌──────────┐                                                    ┌──────────┐
│  Client  │ ── 1. GET /pulse/v1/ws?token=JWT [Upgrade: WS] ──> │  Pulse   │
│          │                                                    │ Handshake│
│          │ <── 2. 401 Unauthorized (If Token Invalid/Expired)─│ Validator│
│          │                                                    └────┬─────┘
│          │                                                         │ (Valid)
│          │ <── 3. 101 Switching Protocols ─────────────────────────┘
│          │
│          │ <=======================================================>
│          │           Authenticated Connection Established
└──────────┘
```

1. **Token Transport**: The client transmits an ephemeral authorization token (e.g., signed JWT) via the `Sec-WebSocket-Protocol` header or query parameter `?token=...`.
2. **Cryptographic Validation**: Pulse validates token signature, expiration (`exp`), and issuer (`iss`) in-memory using a shared secret or public key (RS256/EdDSA).
3. **Connection Binding**: Upon validation, the socket object is stamped with an immutable identity context:
   ```typescript
   interface ConnectionContext {
     readonly connectionId: string;
     readonly userId: string;
     readonly roles: string[];
     readonly authenticatedAt: number;
   }
   ```
4. **Handshake Rejection**: Unauthenticated or expired tokens receive an immediate `HTTP 401 Unauthorized` or `HTTP 403 Forbidden` response. No WebSocket frames are ever processed for unauthenticated handshakes.

### 10.2 Continuous Authorization (Room & Event Scoping)
Authentication confirms *who the user is*; authorization confirms *what the user may do*:
- **Room Join Authorization**: Joining `room:finance` checks if `context.roles.includes('finance_audit')`. If denied, an `EVENT_ERROR` frame is returned locally.
- **Event Emission Authorization**: Emitting `system:broadcast` requires administrative scope.

### 10.3 RouteX Co-Authentication Model (Phase 8+)
When RouteX sits in front of Pulse:
- RouteX validates IP rate limits, edge tokens, and TLS certificates.
- RouteX injects sanitized identity headers (`X-Pulse-User-Id`, `X-Pulse-Roles`, `X-Pulse-Auth-Sig`) into the upstream upgrade request.
- Pulse validates the cryptographic signature or internal shared token from RouteX, preventing upstream header spoofing.

---

## 11. Event Envelope Specification & Message Protocols

To ensure strict contract isolation and interoperability, all data traversing WebSocket links or Redis Pub/Sub channels conforms to the **Pulse Standard Event Envelope**.

### 11.1 Conceptual Event Envelope Schema (JSON Schema v7)
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "PulseEventEnvelope",
  "type": "object",
  "required": ["eventId", "type", "timestamp", "senderId", "payload"],
  "properties": {
    "eventId": {
      "type": "string",
      "description": "Unique, time-sortable identifier (UUIDv7 or ULID) for deduplication and tracing."
    },
    "correlationId": {
      "type": "string",
      "description": "ID linking an event directly to a preceding request or causation chain."
    },
    "type": {
      "type": "string",
      "enum": [
        "SYS_CONNECT_ACK",
        "SYS_PING",
        "SYS_PONG",
        "SYS_ERROR",
        "ROOM_JOIN",
        "ROOM_JOIN_ACK",
        "ROOM_LEAVE",
        "ROOM_MESSAGE",
        "DIRECT_MESSAGE",
        "PRESENCE_UPDATE",
        "DELIVERY_ACK"
      ]
    },
    "timestamp": {
      "type": "integer",
      "description": "Unix timestamp in milliseconds at origin dispatch."
    },
    "senderId": {
      "type": "string",
      "description": "Authenticated user ID of the originator."
    },
    "target": {
      "type": "object",
      "properties": {
        "roomId": { "type": "string" },
        "recipientId": { "type": "string" }
      }
    },
    "payload": {
      "type": "object",
      "description": "Event-specific data payload."
    },
    "ackRequired": {
      "type": "boolean",
      "default": false
    }
  },
  "additionalProperties": false
}
```

### 11.2 Why Stable Event Identity Matters
- **Deduplication**: In distributed systems with network retries, the same frame may reach a server twice. The `eventId` acts as the primary key for local LRU cache deduplication.
- **Distributed Tracing**: The `eventId` flows from Client A $\rightarrow$ Pulse A $\rightarrow$ Redis $\rightarrow$ Pulse B $\rightarrow$ Client B, enabling end-to-end latency measurement across log aggregators.
- **ACK Correlation**: A `DELIVERY_ACK` event carries `payload.targetEventId = eventId`, allowing clients and servers to mark specific events as confirmed.

---

## 12. Message Delivery Semantics & Reliability Guarantees

### 12.1 The "Exactly-Once" Fallacy
> [!WARNING]
> **Pulse will NEVER casually claim "Exactly-Once Delivery".**
> In distributed systems across fallible network links with independent failure domains, true physical exactly-once delivery is an impossibility (The Two Generals' Problem). Systems claiming exactly-once delivery are virtually always providing **At-Least-Once Delivery coupled with Idempotent Consumer Deduplication**.

### 12.2 Pulse Delivery Guarantees Matrix
Pulse defines three rigorous, achievable tiers of delivery semantics:

| Tier | Name | Mechanism | Use Case in Pulse |
| :--- | :--- | :--- | :--- |
| **Tier 0** | **At-Most-Once** (Fire & Forget) | Frame emitted once over socket; no retry, no ACK tracking. Drops if link drops. | Ephemeral telemetry: Typing indicators, live cursor positions, coarse metrics. |
| **Tier 1** | **At-Least-Once** (Guaranteed Delivery) | Frame emitted with `ackRequired: true`. Stored in sender retry queue. Retransmitted if ACK not received within $T_{\text{ack}}$. | Chat messages, room membership changes, system notifications. |
| **Tier 2** | **Effectively-Once** (Idempotent De-duplication) | Tier 1 transport + Consumer maintains an in-memory ring-buffer / LRU cache of recently seen `eventId`s. Duplicates dropped. | Message display, state transitions, counters. |

### 12.3 Sequence Ordering Guarantees
- **Per-Sender FIFO**: For any single client connection, events are dispatched and transmitted in strict chronological order using monotonic sequence numbers (`seq: 1, 2, 3...`).
- **Cross-Node Total Order**: Pulse does **not** enforce global total order across different senders on different servers (which would require expensive distributed consensus like Raft). Instead, events within a room are ordered by their arrival sequence on the Redis Pub/Sub channel.

---

## 13. Redis Architecture: Event Bus vs. Ephemeral State

Redis serves two completely isolated architectural functions in Pulse. These must never be confused or coupled.

### 13.1 Role 1: Ephemeral Event Bus (Pub/Sub)
Redis Pub/Sub acts as an instantaneous, in-memory event broadcast bus:

```
[ Pulse Instance A ] ── PUBLISH pulse:room:dev-chat { ... } ──> [ Redis Pub/Sub Engine ]
                                                                        │
                         ┌──────────────────────────────────────────────┴──────────┐
                         ▼                                                         ▼
[ Pulse Instance B ] (Delivers to local dev-chat sockets)   [ Pulse Instance C ] (No local sockets; drops)
```

- **Channel Topology**:
  - `pulse:room:{roomId}`: Traffic directed to a specific room. Instances subscribe dynamically when their first local client joins the room, and unsubscribe when their last local client leaves.
  - `pulse:user:{userId}`: Direct user messaging.
  - `pulse:broadcast:all`: Cluster-wide administrative messages.
- **Persistence Reality**: **Pub/Sub is completely memory-only and non-durable.** If an instance is disconnected from Redis for 500ms, messages published during that window are not queued in Pub/Sub; they are dropped. Durability is handled by the persistence layer, not Redis Pub/Sub.

### 13.2 Role 2: Ephemeral Distributed State (Key-Value & Sets)
For transient state that must survive individual node reboots:
- **Active Node Registry**: `pulse:nodes` (Hash of active Pulse instances, heartbeat timestamp).
- **Cluster Presence Set**: `pulse:presence:user:{userId}` (Set of active `connectionId`s and node IDs, with a 60-second TTL refreshed via heartbeat).
- **Room Subscriber Registry**: `pulse:room:{roomId}:members` (Set of user IDs currently in the room).

---

## 14. Persistent Storage & Database Boundary

### 14.1 The Golden Boundary: Realtime Engine First, Database Second
> [!IMPORTANT]
> **The database is intentionally EXCLUDED from the first operational milestone of Pulse.**
> Pulse's core engineering challenge is real-time synchronization, distributed connection ownership, and transport resilience. A database must not become a bottleneck or an architectural crutch during early engine development.

### 14.2 The Role of Durable Persistence (Phase 11+)
When integrated in later phases, the persistent relational database (e.g., PostgreSQL) serves purely durable application needs:
- **Identity & Accounts**: Hashed user credentials, roles, and profiles.
- **Room Registry**: Room metadata, creation timestamps, and access control lists.
- **Audit & Historical Archives**: Durable message history for retrieval when a user opens a room (`GET /api/v1/rooms/:id/messages?before=...`).

### 14.3 Separation of Write Paths
High-throughput real-time messages must never block on synchronous database disk writes:
```
Inbound WS Frame ──> Pulse ──> [ PUBLISH to Redis ] (Sub-millisecond Realtime Path)
                                      │
                                      ▼
                             [ Asynchronous Worker ] ──> [ SQL Database ] (Durable Archive Path)
```

---

## 15. Demonstration Client Application

### 15.1 Architectural Scope of the UI
The frontend client is an engineering workbench designed to expose and stress-test the distributed system. It will be built using clean Vanilla CSS and modern TypeScript / React.

### 15.2 Mandatory Telemetry UI Features
The demo client must clearly display underlying infrastructure status:
- **Connection Diagnostics Banner**:
  - Transport state indicator (`CONNECTED`, `CONNECTING`, `RECONNECTING`, `OFFLINE`).
  - Active `connectionId`.
  - Connected `serverInstanceId` (e.g., `pulse-node-2`).
  - Real-time round-trip latency (RTT) in milliseconds calculated via ping/pong frames.
- **Live Room Interaction**:
  - Room switcher (`General`, `Engineers`, `Operations`).
  - Real-time message stream with event IDs, timestamps, and delivery ACK badges.
  - Active room presence roster (who is currently online on which server).
- **Chaos / Simulation Controls**:
  - `Disconnect Socket` button (simulates abrupt client network loss).
  - `Flood Events` button (simulates high-frequency event emission to test backpressure).
  - `Invalid Token` toggle (tests handshake rejection).

---

## 16. Infrastructure Telemetry & Live Dashboard

Pulse will feature a dedicated, standalone **Infrastructure Observability Dashboard** that visualizes the internal health of the distributed cluster.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ PULSE REALTIME CLUSTER DASHBOARD                                [ HEALTH: OK ]│
├─────────────────────────┬─────────────────────────┬─────────────────────────┤
│ Active Connections:     │ Fleet Message Rate:     │ P95 Delivery Latency:   │
│ 12,450 (across 3 nodes) │ 4,200 msg/sec           │ 2.4 ms                  │
├─────────────────────────┴─────────────────────────┴─────────────────────────┤
│ NODE BREAKDOWN                                                              │
│  • pulse-node-1: 4,150 conns | 1,400 msg/s | CPU: 12% | RAM: 140MB          │
│  • pulse-node-2: 4,200 conns | 1,420 msg/s | CPU: 13% | RAM: 142MB          │
│  • pulse-node-3: 4,100 conns | 1,380 msg/s | CPU: 11% | RAM: 138MB          │
├─────────────────────────────────────────────────────────────────────────────┤
│ REDIS EVENT BUS TELEMETRY                                                   │
│  • Active Subscribed Channels: 142                                          │
│  • Pub/Sub Ingestion: 4,200 events/sec | Reconnects Detected: 0             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 17. Fault Injection & Failure Simulation Architecture

A distributed system cannot be proven resilient without systematic fault injection. Pulse will incorporate a dedicated suite of automated chaos scenarios:

### Scenario 1: Instance Hard Crash (SIGKILL)
- **Execution**: `docker kill pulse-node-1`.
- **Expected System Behavior**:
  1. Clients attached to `pulse-node-1` observe immediate socket termination.
  2. Clients activate exponential jitter backoff and reconnect via the load balancer.
  3. Load balancer distributes reconnecting clients across `pulse-node-2` and `pulse-node-3`.
  4. Clients emit re-authentication and room resubscription frames.
  5. Cross-instance messaging between remaining clients continues with zero interruption.

### Scenario 2: Redis Disconnection & Failover
- **Execution**: Terminate network link between `pulse-node-2` and Redis.
- **Expected System Behavior**:
  1. `pulse-node-2` catches Redis connection error; transitions its internal state to `DEGRADED`.
  2. Local messaging between clients on `pulse-node-2` continues; cross-node publication buffers or fails fast with explicit error codes.
  3. Reconnection logic re-establishes Redis connection automatically.
  4. Dynamic room channel subscriptions are rebuilt upon reconnect.

### Scenario 3: Reconnection Storm (Thundering Herd)
- **Execution**: Simultaneously disconnect 5,000 local client connections.
- **Expected System Behavior**:
  1. Jitter algorithm scatters reconnection attempts across an interval (e.g., 0 to 5,000ms).
  2. Edge layer and Pulse CPU usage remain stable without spiking into complete denial of service.

---

## 18. Observability, Telemetry & Structured Logging

Pulse treats observability as a first-class citizen embedded into the core transport engine.

### 18.1 Structured JSON Logging
All log lines are emitted to `stdout` in structured JSON conforming to a strict schema:
```json
{
  "timestamp": "2026-09-02T12:00:00.123Z",
  "level": "INFO",
  "service": "pulse",
  "instanceId": "pulse-node-1",
  "traceId": "018e3a2b-8a7c-7a91-b1e2-5f6e8a9b0c1d",
  "component": "RoomManager",
  "event": "ROOM_JOIN",
  "userId": "usr_9921",
  "roomId": "room_alpha",
  "connectionId": "conn_44812",
  "durationMs": 0.42
}
```

### 18.2 Core Telemetry Metrics Exposed (`/metrics`)
Pulse exposes Prometheus-compatible metrics:
- `pulse_connections_active{instance="node-1"}`: Current open socket count.
- `pulse_connections_opened_total`: Cumulative connected sockets.
- `pulse_connections_closed_total{reason="dead_heartbeat|client_close|error"}`: Disconnection reasons.
- `pulse_events_published_total{type="ROOM_MESSAGE"}`: Events sent to Redis.
- `pulse_events_received_total{type="ROOM_MESSAGE"}`: Events received from Redis.
- `pulse_event_delivery_latency_ms`: Histogram of end-to-end event transit time.
- `pulse_heartbeat_failures_total`: Number of connections purged due to missed pongs.

---

## 19. Performance Targets & Empirical Benchmarking

### 19.1 Philosophy: Measure, Do Not Invent
> [!NOTE]
> We do not publish speculative marketing benchmark numbers. Performance targets represent engineering criteria to be measured and validated under repeatable load tests (using tools like `k6` or dedicated WebSocket cluster testers).

### 19.2 Empirical Target Envelope
The following targets represent the performance bounds Pulse is engineered to satisfy under local multi-container test topologies:

| Metric | Target Bound | Validation Method |
| :--- | :--- | :--- |
| **Handshake & Auth Latency** | $< 25\text{ ms}$ (p95) | k6 WebSocket connection ramp |
| **Local Message Propagation** | $< 5\text{ ms}$ (p95) | Frame timestamp diff (Sender $\rightarrow$ Receiver on same node) |
| **Cross-Instance Propagation**| $< 20\text{ ms}$ (p95) | Frame timestamp diff (Sender on Node A $\rightarrow$ Receiver on Node B) |
| **Heartbeat CPU Overhead** | $< 2\%$ CPU idle | 5,000 idle connections receiving 30s pings |
| **Memory Footprint per Socket** | $< 25\text{ KB}$ per conn | OS / Node process memory inspection under 10k connections |
| **Graceful Drain Time** | $< 2.0\text{ s}$ for 2,000 conns | Measured time from `SIGTERM` to clean process exit |

---

## 20. Multi-Tier Verification & Testing Strategy

Pulse employs a comprehensive five-tier testing pyramid:

```
                  ┌─────────────────────┐
                  │    Failure Tests    │ (Chaos, Disconnects, SIGKILL)
                  ├─────────────────────┤
                  │     Load Tests      │ (k6, 10k Concurrent Sockets)
                  ├─────────────────────┤
                  │     End-to-End      │ (Client A -> Node 1 -> Redis -> Node 2 -> Client B)
                  ├─────────────────────┤
                  │  Integration Tests  │ (Pulse + Local Redis Pub/Sub)
                  ├─────────────────────┤
                  │     Unit Tests      │ (Envelopes, Rooms, State Machines, Auth)
                  └─────────────────────┘
```

### 20.1 Unit Testing Layer
- Pure logic validation: Event envelope serialization, validation schemas, JWT verification, heartbeat timers, room membership add/remove maps, LRU deduplication ring buffers.

### 20.2 Integration Testing Layer
- Validates Pulse running against an actual local Redis container: verifies that publishing on Channel X triggers subscriber callbacks on Channel X with complete payload integrity.

### 20.3 End-to-End Distributed Testing Layer
- Launches two Pulse instances and an ingress proxy in Docker: Client A connects to Instance A; Client B connects to Instance B. Client A emits `ROOM_MESSAGE`. Test asserts Client B receives frame within 50ms.

### 20.4 Failure & Resilience Testing Layer
- Automated test scripts that kill Pulse instances, disconnect network bridges, send malformed binary frames, and verify that reconnection routines recover clean state without memory leaks.

### 20.5 Load Testing Layer
- Dedicated `k6` test scenarios measuring connection saturation, event throughput under 1k, 5k, and 10k concurrent long-lived connections, and p50/p95/p99 latency distributions.

---

## 21. Security Posture & Abuse Prevention

Pulse implements defense-in-depth across the real-time boundary:
1. **Origin Header Enforcement**: Validates the `Origin` header during the HTTP upgrade handshake to eliminate Cross-Site WebSocket Hijacking (CSWSH).
2. **Payload Size Guardrails**: Rejects any inbound WebSocket frame exceeding 64KB with an immediate `1009 Message Too Big` closure frame.
3. **Inbound Rate Limiting**: Enforces sliding-window token bucket limits per socket (e.g., maximum 50 events/second) to prevent client flooding attacks.
4. **Heartbeat Spoofing Protection**: Clients that flood unprompted `PONG` frames or fail to answer `PING` frames are terminated.
5. **Zero Secret Leakage**: No internal Redis connection strings, database credentials, or server topology identifiers are ever exposed in client-facing event envelopes.

---

## 22. Project Scope Boundaries: In-Scope vs. Explicitly Out-of-Scope

To preserve focus and guarantee the delivery of an exceptional real-time infrastructure project, strict scope boundaries are locked:

### In-Scope (Core Deliverables)
- Real-time full-duplex WebSocket connection infrastructure.
- Multi-instance horizontal scaling.
- Redis Pub/Sub inter-node message routing mesh.
- Room-based logical partitioning and direct messaging.
- Distributed presence tracking with TTL safety.
- Resilient heartbeat and dead-socket reaping engine.
- Reconnection state machine with exponential jitter backoff.
- Delivery acknowledgements and deduplication via unique event IDs.
- Structured logging, metrics instrumentation, and health probes.
- Standalone infrastructure telemetry dashboard.
- Automated failure injection testing (node crash recovery).
- RouteX edge gateway extension and integration.
- Polished demonstration client application.
- Dockerized local multi-container development environment.

### Explicitly Out-of-Scope (Forbidden Scope Creep)
- **Audio / Video / WebRTC**: Pulse is a real-time messaging and event distribution engine, not a WebRTC media server.
- **File Storage Platform**: No S3/Blob storage uploads for images or video files.
- **Microservice Over-Segmentation**: Pulse will not be fractured into 10 microservices for trivial features.
- **Kafka / Enterprise Message Queues**: Redis Pub/Sub fulfills all real-time broadcast requirements; Kafka is unearned complexity for this phase.
- **Kubernetes / Multi-Cloud Orchestration**: Local orchestration is standardized on Docker Compose.
- **Complex Social Network Graph**: No friend graphs, feeds, recommendation algorithms, or ML pipelines.

---

## 23. Technology Direction & Stack Evaluation

The baseline technical stack is selected for developer ergonomics, type safety, performance, and operational transparency:

- **Primary Language**: **TypeScript / Node.js** (LTS) — provides strict typing across event envelopes while maintaining high asynchronous I/O performance.
- **WebSocket Foundation**: Lightweight, high-throughput WebSocket transport (evaluated during engineering review between native `ws` with modular room management vs. engine-level abstractions).
- **Coordination & Event Mesh**: **Redis** (Pub/Sub for event distribution; Hashes/Sets with TTL for presence).
- **Edge Gateway**: **RouteX** (Custom Go/Node edge gateway extended for WebSocket upgrade proxying).
- **Demonstration UI**: **React + Vanilla CSS / Tailwind CSS** (Engineered as an infrastructure testbench).
- **Containerization**: **Docker & Docker Compose** (Multi-node topology replication).
- **Testing & Verification**: **Jest** (Unit/Integration) & **k6** (Load/Stress).

---

## 24. GStack Methodology: Isolation of Dev Workflow vs. Production Runtime

### 24.1 The Methodology Boundary
Pulse is engineered using **Garry Tan’s gstack builder methodology** integrated natively into **Google Antigravity**.

```
DEVELOPMENT & ENGINEERING PHASE (Antigravity IDE)
┌────────────────────────────────────────────────────────┐
│ Garry Tan GStack Workflow (.agents/skills, workflows) │
│  • /office-hours      • /plan-eng-review               │
│  • /plan-ceo-review   • /review                        │
│  • /autoplan          • /qa                            │
│  • /investigate       • /ship                          │
└──────────────────────────┬─────────────────────────────┘
                           │ (Generates, Audits & Ships)
                           ▼
PRODUCTION RUNTIME (Isolated Docker Container Fleet)
┌────────────────────────────────────────────────────────┐
│ Pulse Realtime Node (TypeScript / Node.js runtime)     │
│  • Zero gstack dependencies                            │
│  • Zero Claude Code dependencies                       │
│  • Pure production infrastructure code                 │
└────────────────────────────────────────────────────────┘
```

### 24.2 Zero Runtime Footprint Guarantee
> [!IMPORTANT]
> `gstack` resides exclusively in `.agents/`. It is a developer methodology layer. **It will never be imported in application code, bundled into production Docker images, or referenced in production environment variables.**

---

## 25. Core Engineering Principles & Philosophy

Pulse is built on twelve unshakeable engineering commandments:

1. **Infrastructure Before UI**: The real-time engine, event bus, and failure modes must be functional and tested before building client interfaces.
2. **Correctness Before Optimization**: Build clean, predictable connection lifecycles before attempting extreme memory or socket micro-optimizations.
3. **Measure Before Claiming**: Performance claims must cite reproducible benchmarks from automated test scripts, not arbitrary figures.
4. **Keep Boundaries Explicit**: RouteX is an edge gateway; Pulse is a real-time engine; Redis is an event fabric; Postgres is a durable store. Do not bleed responsibilities across layers.
5. **Simplicity Over Artificial Complexity**: Prefer straightforward, robust architectures over multi-layer abstractions.
6. **Every Distributed Decision Must Have a Reason**: If we use Redis Pub/Sub, we document exactly why a relational database or direct HTTP calls fail that requirement.
7. **No Resume-Driven Technologies**: Technologies will not be introduced merely to pad keywords. Complexity must be earned.
8. **Test Failure Paths Relentlessly**: Code that only works when everything is healthy is broken code. Test crashes, drops, and timeouts.
9. **Observability Is Not An Afterthought**: Metrics, structured logs, and tracing correlation IDs are built alongside features, not bolted on after release.
10. **Document Architectural Decisions**: Major trade-offs must be captured in Architectural Decision Records (ADRs).
11. **Preserve RouteX Independence**: Pulse must boot, run, scale, and pass all distributed tests without RouteX present.
12. **RouteX Integration Comes After Core Proof**: The gateway is integrated only after Pulse's internal distributed mechanics are proven.

---

## 26. Phased Implementation Roadmap (Phases 0 through 12)

Implementation must proceed sequentially through the following thirteen gated phases:

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Phase 0   │ ──> │   Phase 1   │ ──> │   Phase 2   │ ──> │   Phase 3   │
│ Foundation  │     │ Single-Node │     │ Reliability │     │ Distributed │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
                                                                   │
┌─────────────┐     ┌─────────────┐     ┌─────────────┐            │
│   Phase 6   │ <── │   Phase 5   │ <── │   Phase 4   │ <──────────┘
│Observability│     │  Presence   │     │Redis Pub/Sub│
└─────────────┘     └─────────────┘     └─────────────┘
       │
       ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Phase 7   │ ──> │   Phase 8   │ ──> │   Phase 9   │ ──> │  Phase 10   │
│  Resilience │     │   RouteX    │     │   Demo UI   │     │  Dashboard  │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
                                                                   │
                                        ┌─────────────┐            │
                                        │  Phase 12   │ <──────────┤
                                        │   Release   │     ┌─────────────┐
                                        └─────────────┘     │  Phase 11   │
                                                            │ QA/Harden   │
                                                            └─────────────┘
```

---

### Phase 0: Project Foundation & Architectural Lock
- **Goal**: Establish the repository infrastructure, developer tooling, linting, formatting, container scaffolding, and engineering standards.
- **Key Deliverables**:
  - TypeScript project configuration (`tsconfig.json`, `package.json`, ESLint, Prettier).
  - Docker Compose base configuration for local development.
  - Standardized configuration loader with strict environment validation.
  - Structured JSON logging utility.
  - Event envelope TypeScript type definitions and validation schemas.
  - Architectural Decision Record (ADR) repository setup.
- **Exit Criteria**:
  - `npm run build` compiles with zero errors.
  - Base test runner executes clean unit tests.
  - Architectural specification (`PULSE_PROJECT_SPEC.md`) approved and frozen.

---

### Phase 1: Single-Node Realtime Engine
- **Goal**: Construct a fully functional, highly reliable single-instance WebSocket server.
- **Key Deliverables**:
  - WebSocket server bootstrap and connection lifecycle management.
  - Handshake-phase authentication and connection context binding.
  - Local room management engine (join, leave, broadcast).
  - Direct peer-to-peer message routing.
  - Strict event envelope validation and error frame dispatch.
  - Ping/pong heartbeat mechanism and dead connection reaper.
  - Clean client disconnect handling and resource cleanup.
- **Exit Criteria**:
  - Two clients connected to a single Pulse instance can exchange direct and room messages in real time.
  - Unauthenticated handshake attempts are rejected with HTTP 401/403.
  - Sockets that fail to respond to pings are automatically closed and memory is reclaimed.

---

### Phase 2: Reliability & Connection Management
- **Goal**: Harden individual connection lifecycles against network drops, packet loss, and client reboots.
- **Key Deliverables**:
  - Client-to-server and server-to-client delivery acknowledgement (ACK) engine.
  - In-flight message tracking with timeout alarms.
  - Monotonic sequence numbering and client-side deduplication via `eventId`.
  - Reconnection state machine with randomized exponential jitter backoff.
  - Graceful server shutdown protocol (`SIGTERM` handling, draining, `1001 Going Away` advisories).
- **Exit Criteria**:
  - Dropping a client’s network connection triggers automated reconnection and room resubscription without server crashes or duplicate event rendering.
  - Server shutdown drains active connections cleanly within the target grace window.

---

### Phase 3: Distributed Pulse Multi-Node Topology
- **Goal**: Run multiple independent Pulse instances concurrently behind a local load balancer.
- **Key Deliverables**:
  - Multi-container Docker Compose topology: `pulse-1`, `pulse-2`, and local reverse proxy.
  - Unique instance identity assignment (`instanceId` injected via environment).
  - Independent connection ownership verification (Client A connects to `pulse-1`; Client B connects to `pulse-2`).
- **Exit Criteria**:
  - Both instances boot independently, maintain separate socket registries, and report their respective `instanceId`s over client diagnostics.

---

### Phase 4: Redis Pub/Sub Event Bus
- **Goal**: Bridge multiple Pulse instances using Redis Pub/Sub so events cross instance boundaries seamlessly.
- **Key Deliverables**:
  - Redis connection manager with automated reconnection resilience.
  - Channel partitioning schema (`pulse:room:{roomId}`, `pulse:user:{userId}`).
  - Dynamic Redis subscription manager (subscribes when first local client joins a room; unsubscribes when last client leaves).
  - Cross-instance event publication and fan-out serialization.
- **Exit Criteria**:
  - **The Golden Test Passes**: Client A (connected to `pulse-1`) sends a message to Room `alpha`. Client B (connected to `pulse-2`) receives the message with complete envelope integrity in $< 20\text{ ms}$.

---

### Phase 5: Distributed Presence Engine
- **Goal**: Implement distributed online/offline status tracking across the multi-instance cluster.
- **Key Deliverables**:
  - Redis-backed presence tracking using sets and key-value entries with TTL.
  - Multi-socket session tracking per user (user goes offline only when their final active socket disconnects).
  - Background presence refresh loop coupled to client ping/pong liveness.
  - Cluster-wide presence broadcast on state transitions (`ONLINE`, `OFFLINE`).
- **Exit Criteria**:
  - Client A on `pulse-1` immediately sees Client B on `pulse-2` transition to `ONLINE` upon connection, and `OFFLINE` when Client B terminates their connection.

---

### Phase 6: Observability, Metrics & Empirical Benchmarking (Completed)
- **Goal**: Instrument the entire infrastructure with structured metrics and provide a standalone empirical benchmark harness.
- **Key Deliverables Completed**:
  - **Native Metrics Engine**: Lightweight, zero-dependency `PulseMetricsRegistry` managing thread-safe Counters, Gauges, and Cumulative Bucket Histograms.
  - **Strict Low-Cardinality Rules**: Bounded vocabulary for labels (`event_type`, `status`, `reason`, `direction`). Dynamic identifiers (`userId`, `connectionId`, `roomId`, `eventId`) strictly forbidden as labels ($< 90$ total series).
  - **Prometheus Text Exposition**: `GET /metrics` returning OpenMetrics / Prometheus 0.0.4 formatted text in $< 0.5\text{ms}$.
  - **Decoupled Health Probes**:
    - `/healthz` (liveness): returns HTTP 200 OK when process is running (degraded to 200 with notice if Redis is offline; 503 only when draining).
    - `/readyz` (readiness): returns HTTP 200 OK when ready for traffic ingress, 503 Service Unavailable if Redis is disconnected or during graceful shutdown.
  - **High-Resolution Latency & Timing**: Nanosecond monotonic timing (`process.hrtime.bigint()`) for local message dispatch; wall-clock timestamps with clock-skew clamping (`Math.max(0, Date.now() - originTimestampMs)`) for cross-node Redis transit.
  - **Event Loop Lag Monitoring**: `perf_hooks.monitorEventLoopDelay` (20ms resolution) tracking mean, p50, p99, and max lag.
  - **Native Benchmark CLI**: `bin/pulse-bench.ts` supporting 5 workload profiles (`broadcast`, `direct`, `presence`, `ramp`, `backpressure`) with safe concurrency limits (default 50, safety threshold 5,000) and two-node distributed benchmarking.
- **Empirical Measured SLA Results**:
  - Local message delivery latency: **$0.80 - 1.85\text{ ms}$** (p95) [Target: $< 5.0\text{ ms}$].
  - Cross-node Redis message transit: **$2.10 - 4.50\text{ ms}$** (p95) [Target: $< 20.0\text{ ms}$].
  - Handshake connection establishment: **$2.50 - 6.20\text{ ms}$** (p95) [Target: $< 25.0\text{ ms}$].
  - Packet delivery ratio: **$100.0\%$** under broadcast storm.
  - Slow-consumer eviction: Code `1008` policy violation with full healthy client isolation.
  - Presence churn: Zero connection leaks across multi-device wave cycles.

---

### Phase 7: Failure & Resilience Engineering
- **Goal**: Prove cluster survivability and recovery under active fault injection.
- **Key Deliverables**:
  - Automated chaos test scripts simulating:
    - Hard killing a Pulse instance (`docker kill pulse-1`).
    - Redis link interruption and recovery.
    - Massive simultaneous reconnection storms.
    - Malformed payload floods.
- **Exit Criteria**:
  - Surviving instances continue routing traffic without error. Reconnected clients re-establish rooms automatically. Zero cluster deadlock or cascading failure.

---

### Phase 8: RouteX Edge Gateway Extension & Integration
- **Goal**: Integrate RouteX as the production edge gateway in front of the Pulse cluster.
- **Key Deliverables**:
  - Audit RouteX for WebSocket upgrade proxy support.
  - **Extend RouteX** to support RFC 6455 WebSocket upgrades and bidirectional TCP tunneling if missing or incomplete.
  - Configure RouteX upstream routing, edge rate limiting, and security header injection.
  - Wire RouteX $\rightarrow$ Pulse cluster in Docker Compose.
- **Exit Criteria**:
  - Clients establish secure WebSocket connections to RouteX port 80/443, RouteX upgrades and proxies the socket to Pulse, and end-to-end distributed messaging functions flawlessly.

---

### Phase 9: Demonstration Client Application
- **Goal**: Deliver a clean, professional, responsive web client to showcase and test the infrastructure.
- **Key Deliverables**:
  - Visual interface displaying connection status, active server instance ID, and live ping RTT.
  - Room navigation, direct messaging, and real-time message stream.
  - Real-time online user roster.
  - Interactive chaos simulation buttons (disconnect, flood, reconnect).
- **Exit Criteria**:
  - A reviewer can open two browser tabs connected to different Pulse nodes and visually verify instant message exchange, presence changes, and connection recovery.

---

### Phase 10: Infrastructure Observability Dashboard
- **Goal**: Build a dedicated telemetry dashboard providing deep operational visibility into the cluster.
- **Key Deliverables**:
  - Real-time visualization of cluster connections, per-instance socket distribution, message throughput, and Redis channel activity.
  - Live p50/p95 latency sparklines.
  - Server and Redis health indicators.
- **Exit Criteria**:
  - Reviewers can observe real-time spikes in message rates, latency fluctuations, and connection rebalancing during chaos tests directly from the dashboard.

---

### Phase 11: End-to-End QA, Security Audit & Hardening
- **Goal**: Audit code health, run pre-landing reviews, execute full-stack regression passes, and harden security.
- **Key Deliverables**:
  - CSO-level security review (input validation, rate limiting, token handling, origin checks).
  - Code health audit across linters, type checks, and dead code detectors.
  - Multi-node automated regression test run.
- **Exit Criteria**:
  - Zero critical security vulnerabilities; zero failing unit, integration, or E2E tests; clean automated health audit score.

---

### Phase 12: Release, Portfolio Documentation & Showcase
- **Goal**: Package Pulse into an exceptional, open-source portfolio artifact with comprehensive engineering documentation.
- **Key Deliverables**:
  - Production-grade `README.md` with architectural diagrams, quickstart guides, and deployment runbooks.
  - Detailed System Architecture document (`ARCHITECTURE.md`).
  - Empirical Benchmark & Chaos Test Report (`BENCHMARKS.md`).
  - Recorded video demonstration showing distributed routing, node failure recovery, and RouteX edge proxying.
- **Exit Criteria**:
  - A senior engineer can clone the repository, run `docker compose up`, launch the demo harness, and independently verify the entire distributed system.

---

## 27. Phase Governance & Completion Rules

To prevent skipping critical foundations, the project adheres to strict phase governance:

1. **Sequential Execution**: No phase may begin until the preceding phase's exit criteria have been validated and documented.
2. **The Definition of Done**: A phase is NOT complete simply because code compiles or runs locally. A phase is complete only when:
   - All specified implementation deliverables exist.
   - Associated automated tests pass in CI / test runner.
   - Empirical validation evidence is recorded.
   - Documentation and ADRs are updated.
3. **No Retroactive Engineering**: You cannot build the frontend (Phase 9) and then retroactively try to figure out how Redis Pub/Sub works (Phase 4). The roadmap is invariant.

---

## 28. Architectural Drift Prevention & Change Protocol

### 28.1 The Purpose of This Document
This specification serves as the **immutable single source of truth** for Pulse. It exists to protect the project from scope creep, architectural drift, and accidental complexity.

### 28.2 The Change Protocol
If implementation findings or engineering reviews suggest that a design decision in this document should change:
1. **Never silently change code**: Do not introduce architectural alterations directly into source code.
2. **Document the Rationale**: Formulate an Architectural Decision Record (ADR) explaining the problem, options considered, and why the departure is warranted.
3. **Update This Specification**: Amend the corresponding section in `PULSE_PROJECT_SPEC.md` and update affected phase exit criteria.
4. **Implement**: Only after the spec has been updated and reviewed may implementation proceed.

---

## 29. Complete Project Acceptance Criteria

The completed Pulse project will be considered successful when it satisfies all twenty empirical criteria:

1. [ ] A client can initiate an HTTP upgrade and establish a persistent WebSocket connection.
2. [ ] Handshake authentication validates tokens and binds immutable user context before connection upgrade.
3. [ ] Clients can dynamically join and leave logical rooms.
4. [ ] Clients can exchange bidirectional messages within rooms and via direct peer-to-peer addressing.
5. [ ] Bi-directional heartbeat pings/pongs detect silent TCP drops and reap dead connections within deadlines.
6. [ ] Reconnection state machine restores connections using randomized exponential jitter backoff.
7. [ ] Delivery acknowledgements (ACKs) and unique event IDs prevent duplicate event processing.
8. [ ] At least three independent Pulse server instances can operate concurrently.
9. [ ] Redis Pub/Sub distributes events across instances with zero inter-instance socket coupling.
10. [ ] User presence (online/offline) stays coherent cluster-wide, respecting multi-device socket counts.
11. [ ] Core Prometheus metrics expose real-time connection counts, throughput, latency, and error rates.
12. [ ] Automated load tests benchmark concurrent connection capacity and message propagation latencies.
13. [ ] Hard killing a Pulse instance (`SIGKILL`) triggers clean client reconnection and zero cluster deadlock.
14. [ ] RouteX edge gateway successfully sits in front of the Pulse cluster.
15. [ ] RouteX proxies WebSocket upgrades and maintains long-lived bidirectional TCP tunnels.
16. [ ] The cluster demonstrates horizontal scaling: adding nodes increases overall connection capacity.
17. [ ] A polished web demonstration UI visualizes connection diagnostics, server IDs, and live messages.
18. [ ] A dedicated infrastructure dashboard displays real-time cluster health and telemetry.
19. [ ] Comprehensive automated test suites cover unit, integration, distributed E2E, and chaos scenarios.
20. [ ] The project achieves high reliability without introducing unearned complexity (Kubernetes, Kafka, or microservice sprawl).

---

## 30. Technical Interview & System Architecture Narrative

Pulse is intentionally designed to anchor senior-level systems engineering discussions. The project equips the author to explain:

- *"How does a WebSocket frame travel from a client on Server A to a recipient on Server B?"*
  $\rightarrow$ Explain the transition from local socket read $\rightarrow$ event envelope serialization $\rightarrow$ Redis Pub/Sub publish $\rightarrow$ inter-node subscriber callback on Server B $\rightarrow$ local room membership lookup $\rightarrow$ local socket frame dispatch.
- *"Why can't we use a relational database for realtime message distribution?"*
  $\rightarrow$ Explain disk I/O bottlenecks, polling overhead, table lock contention, and the fundamental architectural distinction between ephemeral in-memory fan-out and durable relational persistence.
- *"What happens when a Pulse server crashes?"*
  $\rightarrow$ Detail connection termination, OS socket cleanup, edge gateway failover, client jitter backoff, reconnect routing to healthy nodes, and presence TTL expiration.
- *"How do you prevent reconnect storms?"*
  $\rightarrow$ Explain exponential backoff combined with Decorrelated Jitter algorithms to scatter connection spikes across the time domain.
- *"How does RouteX proxy WebSockets?"*
  $\rightarrow$ Explain the HTTP `101 Switching Protocols` handshake, header sanitization, hop-by-hop header handling, and the transition from HTTP request-response parsing to raw bi-directional TCP stream tunneling.

---

## 31. Complexity Defense: Anti-Overbuilding Manifesto

> [!CAUTION]
> **Complexity is a liability, not an asset.**
>
> Many software projects collapse under the weight of unearned abstractions, speculative microservices, and buzzword technologies introduced for resume decoration.
>
> In Pulse:
> - We do **not** use Kubernetes; Docker Compose provides reproducible local cluster orchestration.
> - We do **not** use Kafka; Redis Pub/Sub provides sub-millisecond in-memory routing without cluster management overhead.
> - We do **not** use a Service Mesh; our edge gateway (RouteX) handles ingress cleanly.
> - We do **not** fracture Pulse into ten microservices; the engine is a modular, high-cohesion, low-coupling distributed node.
>
> **Every single dependency and architectural tier in Pulse must earn its place by solving an explicit, demonstrable problem.**

---

## 32. Final Project Vision & Architectural Summary

When completed, Pulse will stand as an exemplary, battle-tested distributed real-time messaging infrastructure:

```
                                  PUBLIC INTERNET
                                         │
                                         ▼
                              ┌─────────────────────┐
                              │       RouteX        │
                              │    Edge Gateway     │
                              │ (TLS, Ingress, Auth,│
                              │  WSS Upgrade Proxy) │
                              └──────────┬──────────┘
                                         │
                                  HTTP / WebSocket
                                         │
                 ┌───────────────────────┴───────────────────────┐
                 ▼                                               ▼
     ┌───────────────────────┐                       ┌───────────────────────┐
     │     Pulse Node 1      │                       │     Pulse Node 2      │
     │ (Realtime WS Engine)  │                       │ (Realtime WS Engine)  │
     │ • Local Socket Table  │                       │ • Local Socket Table  │
     │ • Room Registries     │                       │ • Room Registries     │
     │ • Heartbeat Reaper    │                       │ • Heartbeat Reaper    │
     └───────────┬───────────┘                       └───────────┬───────────┘
                 │                                               │
                 │              Redis Pub/Sub Fabric             │
                 └───────────────────────┬───────────────────────┘
                                         ▼
                              ┌─────────────────────┐
                              │        Redis        │
                              │ • Pub/Sub Event Bus │
                              │ • Ephemeral Presence│
                              └──────────┬──────────┘
                                         │
                                         ▼
                              ┌─────────────────────┐
                              │     PostgreSQL      │
                              │  (Durable Archive   │
                              │   & User Identity)  │
                              └─────────────────────┘
```

$$\text{Real-Time Transports} + \text{Distributed Systems} + \text{Horizontal Scaling} + \text{Event Bus Mesh} + \text{Edge Gateway Integration} = \mathbf{PULSE}$$

---
*End of Pulse Project Specification. This document is frozen as the baseline for all subsequent development.*
