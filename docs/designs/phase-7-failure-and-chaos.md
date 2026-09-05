# Architecture Design: Phase 7 — Failure Injection & Chaos Testing

**Project**: Pulse — Distributed Real-Time Messaging Infrastructure  
**Author**: Pulse Systems & Architecture (Office Hours)  
**Status**: APPROVED  
**Date**: 2026-09-06  
**Scope**: Phase 7 Failure & Resilience Engineering  

---

## 1. Executive Summary & Core Premise

Pulse has completed single-node reliability, distributed Redis scale-out, distributed presence, and production observability with sub-millisecond dispatch and Prometheus exposition. 

Phase 7 proves **cluster survivability, self-healing, and deterministic failure bounds** under active fault injection. Rather than introducing brittle external chaos daemons (Chaos Mesh, Toxiproxy sidecars) or polluting the production hot path with artificial test switches, Phase 7 introduces a **zero-dependency, programmable TCP Fault Interceptor (`FaultProxy`)** alongside a native test runner (`bin/pulse-chaos.ts` and Jest integration suites).

```text
               CHAOS TEST TOPOLOGY (ZERO HOT-PATH MUTATION)
               
  [ PulseClientSession ]
           │
           ▼
  ┌─────────────────────────────────────────────────────────────┐
  │         Programmable TCP Fault Interceptor (FaultProxy)      │
  │  - Latency jitter / sleep    - Packet drop (loss %)         │
  │  - Abrupt TCP RST severance  - Half-open silent blackhole   │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
                                 ▼
                     [ Pulse Server Node 1 / 2 ]
                                 │
                    (Optional Redis Fault Proxy)
                                 │
                                 ▼
                          [ Redis 7 Cluster ]
```

---

## 2. Critical Evaluation of the 10 Failure Domains

### 2.1 Redis Outage and Recovery
- **Failure Semantics**: Redis link failure (`ECONNREFUSED`, network partition, or packet blackhole) must **never crash Pulse** or block purely local message delivery.
  - Sockets connected to a surviving node continue routing local room messages and local direct messages.
  - `/healthz` (liveness) returns `200 OK` with `status: "DEGRADED"`.
  - `/readyz` (readiness) returns `503 Service Unavailable` with `status: "NOT_READY"`.
  - Inbound and outbound Redis publications fail gracefully with increments to `pulse_redis_publish_total{status="error"}`.
- **Recovery Guarantees**:
  - `RedisConnectionManager` auto-reconnects with exponential backoff and jitter (`retryInitialDelayMs: 100`, `retryMaxDelayMs: 3000`).
  - Upon reconnection, `handleRedisReconnect()` must atomically re-subscribe all active room and user channels registered in `ChannelRegistry`.
  - `/readyz` transitions back to `200 OK` (`status: "READY"`).
  - Cross-node message transit resumes with recovery latency measured under $< 500\text{ms}$ post-socket restoration.

### 2.2 Pulse Node Crash & Client Reconnect Recovery
- **Failure Semantics**: Sudden termination of a Pulse node (`SIGKILL`, container halt, unhandled crash) abruptly drops transport sockets (TCP RST/FIN).
- **Recovery Guarantees**:
  - Surviving cluster nodes continue operating with zero degradation or cascading failure.
  - Disconnected `PulseClientSession` instances detect transport termination (`code: 1006`), transition to `RECONNECTING`, and initiate exponential backoff with decorrelated jitter.
  - Upon reconnecting to an alternate node:
    1. Authenticate with HMAC-SHA256 JWT.
    2. Automatically issue `ROOM_BATCH_JOIN` for all previously joined rooms.
    3. Re-flush unacknowledged frames from the local in-flight retry queue with advanced transport `seq` while preserving logical `eventId` and `correlationId`.

### 2.3 Reconnect Storms (Thundering Herd Defense)
- **Failure Semantics**: When a primary node dies with 1,000+ connected clients, all clients disconnect simultaneously.
- **Recovery Guarantees**:
  - `PulseClientSession` enforces **decorrelated jitter** (`min(maxDelay, baseDelay * 2^attempt + randomJitter)`) preventing synchronized connection waves.
  - Server accepts incoming connections at controlled rates without event loop lag spikes ($p99 < 50\text{ms}$).
  - `pulse_connections_total{status="success"}` ramps smoothly without kernel socket backlog drops.

### 2.4 Half-Open / Silent Blackhole Connections
- **Failure Semantics**: Network routes drop packets silently without sending TCP FIN/RST (e.g. frozen cellular links, severed NAT table mappings, laptop sleep).
- **Recovery Guarantees**:
  - `HeartbeatManager` sub-tick scheduler audits idle socket duration every `sweepTickMs = Math.min(interval, timeout) / 2`.
  - If silence exceeds `heartbeatIntervalMs` (default 30s), sends native RFC 6455 opcode 0x9 Ping.
  - If silence exceeds `heartbeatIntervalMs + heartbeatTimeoutMs` (default 40s), server forcefully tears down the dead socket (`ws.terminate()`), clears room memberships, removes presence leases, and increments `pulse_connections_closed_total{reason="heartbeat_timeout"}`.
  - Enforces zero file descriptor or memory leakage.

### 2.5 ACK Loss, Retransmission & Idempotency Invariants
- **Failure Semantics**: Network drops downlink `DELIVERY_ACK` frames back to the sender after the server has successfully committed and broadcasted the message.
- **Recovery Guarantees**:
  - Client retry timer fires (`ackTimeoutMs: 2000`).
  - Client retransmits frame with identical `eventId` and payload, but incremented transport `seq`.
  - Server's `IdempotencyManager` (LRU ring buffer) intercepts the duplicated `eventId`:
    1. Compares SHA-256 payload digest.
    2. If matching: **bypasses transport sequence check**, replays cached `DELIVERY_ACK`, and **strictly suppresses duplicate delivery** to room members.
    3. If payload differs: rejects with `EVENT_ID_CONFLICT` policy error.

### 2.6 Slow Consumers & Backpressure Eviction
- **Failure Semantics**: A hostile or degraded consumer throttles TCP socket reads, allowing outbound frames to accumulate in server memory.
- **Recovery Guarantees**:
  - `Connection.send()` inspects `socket.bufferedAmount`.
  - If `bufferedAmount > maxBufferedAmountBytes` (default 1 MB), server evicts the slow consumer immediately with RFC 6455 status `1008` (Policy Violation), drops pending frames, and increments `pulse_messages_dropped_total{reason="slow_consumer"}`.
  - Co-located healthy consumers in the same room continue receiving uninterrupted broadcast traffic with zero frame loss.

### 2.7 Graceful Shutdown & Connection Draining
- **Failure Semantics**: Node receives `SIGTERM` / `SIGINT` from orchestration.
- **Recovery Guarantees**:
  - Server enters draining state: `/readyz` immediately switches to HTTP 503 (`ready: false, status: "DRAINING"`).
  - New WebSocket upgrades are rejected with HTTP 503 Service Unavailable.
  - Active sockets receive clean close frames (`code: 1000, reason: "Server shutting down"`), prompting clients to reconnect to peer nodes immediately.
  - In-flight messages and Redis buffers drain before process exit within `gracePeriodMs` (default 2000ms).

### 2.8 Distributed Presence Recovery & Lease Eviction
- **Failure Semantics**: A node crashes while holding 500 active user presence leases in Redis.
- **Recovery Guarantees**:
  - Presence keys (`presence:user:{userId}:devices` and `presence:room:{roomId}`) carry 30s TTL.
  - Even if the dead node cannot send `PRESENCE_UPDATE` `OFFLINE` packets, Redis automatically evicts stale leases upon TTL expiration.
  - Peer node rosters update cleanly via background pruning.
  - When Redis experiences an outage and recovers, surviving nodes re-sync active leases on the next heartbeat renewal tick.

### 2.9 Failure Detection & Recovery Latency Telemetry
- **Observability Strategy**: Phase 7 relies strictly on the Phase 6 Prometheus metrics engine:
  - `pulse_redis_connection_state` (0/1 transition)
  - `pulse_redis_publish_total{status="error"}`
  - `pulse_connections_closed_total{reason="heartbeat_timeout"|"slow_consumer"|"server_shutdown"}`
  - `pulse_messages_dropped_total{reason="slow_consumer"}`
  - `pulse_event_loop_lag_p99_seconds`
  - `pulse_cross_node_transit_seconds`
- **Measured Metrics in Chaos Reports**:
  - **MTTD (Mean Time to Detect)**: Timestamp of fault injection $\rightarrow$ timestamp metric reflects failure (e.g. `/readyz` 503 or heartbeat timeout close).
  - **MTTR (Mean Time to Recover)**: Timestamp of fault resolution $\rightarrow$ timestamp metric recovers (e.g. `/readyz` 200 and successful cross-node delivery).

### 2.10 Safe & Deterministic Local Chaos Orchestration
- **Guiding Principle**: Chaos tests must run reliably on a developer laptop without requiring root permissions, iptables, Toxiproxy daemons, or Kubernetes.
- **Mechanism**:
  - A lightweight, pure Node.js TCP `FaultProxy` created in `src/chaos/FaultProxy.ts` (or `tests/chaos/`) using native `net.createServer`.
  - The proxy forwards TCP bytes between Client $\leftrightarrow$ Pulse or Pulse $\leftrightarrow$ Redis, exposing programmable control hooks:
    - `.sever()`: Abruptly destroys TCP sockets (`socket.destroy()`), simulating dead hardware.
    - `.blackhole(true/false)`: Silently drops all incoming/outgoing bytes without closing sockets, simulating half-open connection loss.
    - `.dropPackets(probability)`: Randomly drops $N\%$ of TCP chunks or WebSocket frames.
    - `.injectLatency(minMs, maxMs)`: Simulates degraded WAN latency or packet queuing.
    - `.restore()`: Instantly restores normal full-duplex TCP forwarding.

---

## 3. Engineering Boundaries: In Scope vs. Out of Scope

| Component / Capability | In Scope (Phase 7) | Out of Scope (Deferred) |
| :--- | :--- | :--- |
| **Fault Interception** | Native Node.js `net` TCP Fault Proxy | Toxiproxy sidecar, iptables, eBPF |
| **Process Lifecycle** | Node child processes & Docker Compose `stop/start/kill` | Kubernetes Chaos Mesh, Litmus, Nomad |
| **Cluster Topology** | 2 Pulse nodes + 1 Redis instance | 10+ node geo-distributed clusters |
| **Telemetry System** | Phase 6 Prometheus `/metrics` and `/readyz` | OpenTelemetry Collector, Grafana, Datadog |
| **Delivery Semantics** | At-least-once with idempotent deduplication | Exactly-once distributed consensus (Raft/Paxos) |
| **Database State** | Ephemeral Redis Pub/Sub and Presence keys | PostgreSQL, SQLite, persistent event stores |
| **Edge Gateway** | Direct WebSocket connections to Pulse nodes | RouteX reverse proxy (Phase 8) |

---

## 4. Test Architecture & Directory Structure

```text
src/chaos/
├── FaultProxy.ts               # Programmable TCP loopback proxy (packet loss, latency, RST, blackhole)
├── ChaosScenarioRunner.ts      # Orchestrator for multi-step fault injection scenarios
└── types.ts                    # Chaos scenario configs, fault state, and recovery assertions

bin/
└── pulse-chaos.ts              # Standalone CLI entrypoint for manual / automated chaos drills

tests/chaos/
├── RedisOutageAndRecovery.chaos.test.ts      # Redis severed -> local routing -> auto-reconnect
├── NodeCrashAndClientRecovery.chaos.test.ts  # Node 1 killed -> client reconnects to Node 2
├── ReconnectStorm.chaos.test.ts              # 500 clients reconnect with decorrelated jitter
├── HalfOpenConnectionReap.chaos.test.ts      # Silent blackhole -> heartbeat timeout eviction
├── AckLossAndDeduplication.chaos.test.ts     # Dropped ACKs -> retransmit -> idempotent ACK replay
├── BackpressureEviction.chaos.test.ts        # Slow consumer -> buffer ceiling -> code 1008
└── GracefulDraining.chaos.test.ts            # Server stop -> 503 readyz -> clean 1000 close
```

---

## 5. Failure Semantics & Recovery Guarantees Specification

| Scenario | Injected Fault | Expected System Reaction | Recovery Guarantee |
| :--- | :--- | :--- | :--- |
| **1. Redis Severance** | TCP disconnect to Redis | `/healthz` stays 200 (DEGRADED); `/readyz` returns 503; local room frames route normally | Auto-reconnects on Redis restore; re-subscribes all active rooms; `/readyz` recovers to 200 |
| **2. Node Crash** | `SIGKILL` on Node 1 | Node 1 dies immediately; Node 2 unaffected | Clients reconnect to Node 2 via jitter; batch-join rooms; in-flight frames re-sent and ACKed |
| **3. Stale Half-Open** | TCP blackhole (silent freeze) | Client stops answering PING | Reaped within `intervalMs + timeoutMs`; socket destroyed; room memberships cleared |
| **4. Lost ACK** | Downlink frame drop (100% ACKs) | Client retry timer fires after `ackTimeoutMs` | Retransmission intercepted by idempotency ring; cached ACK replayed; 0 duplicate room frames |
| **5. Slow Consumer** | Client pauses TCP socket read | `bufferedAmount` exceeds `maxBufferedAmountBytes` | Socket closed with code `1008`; pending frames dropped; healthy room peers receive 100% frames |
| **6. Presence Expiry** | Node killed with active leases | Node cannot emit `OFFLINE` packets | Redis ephemeral leases expire in 30s via TTL; remote roster prunes dead users automatically |
| **7. Reconnect Storm** | 500 clients dropped at $t=0$ | Simultaneous reconnect attempts | Decorrelated jitter flattens arrival distribution; server $p99$ event loop lag $< 50\text{ms}$ |

---

## 6. Acceptance Criteria for Phase 7

1. **Deterministic Execution**: All chaos suites run and pass in local CI (`npm test`) in $< 60\text{s}$ without hanging handles or flaky port conflicts.
2. **Zero Hot-Path Intrusion**: Zero chaos flags, test conditionals, or debugging hooks injected into `src/core/` production modules.
3. **Observability Verification**: Chaos tests verify MTTD and MTTR by scraping `/metrics` and asserting on standard Prometheus gauges and counters.
4. **Complete Teardown**: Every chaos scenario guarantees 100% cleanup of TCP proxies, child processes, open sockets, and Redis mock keys upon test completion.
5. **CLI Repeatability**: `npx tsx bin/pulse-chaos.ts --scenario all` allows developer drills against standalone local or Docker topologies.

---

## 7. Concrete Architectural Decision & Next Steps

- **Approved Approach**: **Approach B (Native Programmable TCP Fault Interceptor & `pulse-chaos` CLI)**.
- **Immediate Work**:
  1. Implement `src/chaos/FaultProxy.ts` with clean socket lifecycle and fault injection hooks (`sever`, `blackhole`, `drop`, `delay`).
  2. Implement the 7 targeted chaos suites in `tests/chaos/`.
  3. Create `bin/pulse-chaos.ts` CLI for standalone verification.
  4. Update `README.md` and `PULSE_PROJECT_SPEC.md` with Phase 7 failure semantics and chaos drill usage.
