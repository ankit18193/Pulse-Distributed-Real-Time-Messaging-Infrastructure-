# Pulse — Distributed Real-Time Messaging Infrastructure
# Phase 8 — RouteX Edge Gateway Integration
# Architectural Design & Specification (Targeted Corrections Incorporated)

> **Document Status**: APPROVED WITH TARGETED CORRECTIONS  
> **Phase**: Phase 8 — RouteX Edge Gateway Integration  
> **Baseline**: Phase 7 Complete (`32298fa`)  
> **Target Systems**: RouteX (`D:\RouteX\RouteX`) & Pulse (`D:\Pulse\Pulse-Distributed-Real-Time-Messaging-Infrastructure-`)

---

## 1. Architectural Verdict

### Verdict
**`APPROVED WITH TARGETED CORRECTIONS`**

### Summary of Targeted Architectural Invariants
1. **`Sec-WebSocket-Extensions` Negotiation Rule**: RouteX forwards the client's requested extension header to Pulse and forwards Pulse's negotiated extension response back to the client. RouteX does NOT modify, invent, decompress, or negotiate extensions itself.
2. **Explicit Trusted Boundary for Pulse Client IP Resolution**: Pulse only trusts `X-Forwarded-For` when the request originates from an explicitly configured trusted RouteX gateway address (`trustProxy: true` with `req.socket.remoteAddress` in trusted list). Otherwise, `req.socket.remoteAddress` remains strictly authoritative.
3. **Dedicated WebSocket State Machine with Ironclad Tunnel Invariant**:
   - **BEFORE 101**: Connect failure / dial error (`ECONNREFUSED`, timeout) $\rightarrow$ eligible for bounded failover to next ready node (max 1 retry).
   - **AFTER 101**: State transitions to `ACTIVE_TUNNEL`. **NEVER retry, NEVER select another upstream, NEVER duplicate the connection**.
4. **Physical Connection Reconnect vs. Distributed Message Delivery**: Redis Pub/Sub does not restore a WebSocket session. On node failure, RouteX terminates the broken tunnel; the client detects the drop, opens a *new physical connection* to another node via RouteX, re-authenticates, and re-subscribes to rooms; Redis Pub/Sub handles the cross-node broadcast continuity.
5. **Native Stream Backpressure Separation**: RouteX has zero awareness of Pulse's `bufferedAmount` or 64KB thresholds. RouteX enforces native Node.js TCP stream backpressure (`pipe()`). Transport pressure propagates naturally, Pulse decides eviction independently, and RouteX memory stays bounded.
6. **Strict 11-Step WebSocket Upgrade Lifecycle**: Encoded directly into the upgrade proxy state machine from client handshake to `ACTIVE_TUNNEL`.

---

## 2. Capability Assessment (Verified Against Codebases)

### RouteX Codebase Assessment (`D:\RouteX\RouteX`)
- **Runtime & Status**: Fastify v5.2.1, Undici v7.4.0, ioredis v5.6.0, Pino v9.6.0, Zod v3.24.2. 38 test suites, 300 tests passing (100%).
- **Routing & Proxy**: Longest prefix matching in [`ProxyRouter.ts`](file:///D:/RouteX/RouteX/src/proxy/router.ts). Reverse proxy dispatch in [`stream-handler.ts`](file:///D:/RouteX/RouteX/src/proxy/stream-handler.ts) strictly uses Undici `Pool.request()`.
- **Headers & Sanitization** ([`headers.ts`](file:///D:/RouteX/RouteX/src/proxy/headers.ts)): Strips hop-by-hop headers, deletes untrusted incoming identity headers (`x-user-id`, `x-user-roles`, `x-auth-type`, `x-gateway-*`, `x-internal-*`), and injects `x-request-id`, `x-forwarded-for`, `x-forwarded-proto`, `x-forwarded-host`, and `x-gateway-forwarded-by: routex`.
- **Built-in Endpoints** ([`gateway-server.ts`](file:///D:/RouteX/RouteX/src/server/gateway-server.ts)): `/healthz`, `/livez`, `/gateway/healthz`, `/readyz`, and catch-all `ALL /*`.
- **Existing Limitations**: No HTTP `'upgrade'` listener on `this.app.server`. No duplex TCP stream tunneling capability. Single string `upstream: z.string().url()` in schema.

### Pulse Codebase Assessment (`D:\Pulse\Pulse-Distributed-Real-Time-Messaging-Infrastructure-`)
- **Runtime & Status**: Native Node.js `http.createServer` + `ws.WebSocketServer({ noServer: true })`. 73 test suites, 345 tests passing (100%).
- **Upgrade Handling**: Handled in [`PulseServer.ts`](file:///d:/Pulse/Pulse-Distributed-Real-Time-Messaging-Infrastructure-/src/core/PulseServer.ts) (`httpServer.on('upgrade', ...)`). Path-agnostic.
- **Authentication**: Custom 2-part HMAC-SHA256 token verification (`Authenticator.ts`) via query string `?token=...`, header `Authorization: Bearer ...`, or `Sec-WebSocket-Protocol: token.<val>`.
- **Stateless Multi-Node Architecture**: Multi-instance room broadcasts and user messaging route seamlessly over Redis Pub/Sub channels (`pulse:room:<roomId>`, `pulse:user:<userId>`).
- **Distributed Presence**: Maintained in Redis sorted sets and hashes with periodic heartbeat renewal (`PresenceManager.ts`).
- **Health Probes**:
  - `/healthz` (and `/health`): 200 `OK` (or `DEGRADED` if Redis is down), 503 if `DRAINING`.
  - `/readyz`: 200 `READY` if Redis is connected and alive; 503 `NOT_READY` if Redis is disconnected; 503 `DRAINING`.
  - `/metrics`: Prometheus text serialization.
- **Graceful Draining**: `drain()` triggers 503 on `/readyz`, sends WebSocket 1001 Going Away close frames, and flushes presence.

---

## 3. Targeted Invariant 1: WebSocket Extension & Subprotocol Negotiation

### The Rule
```
Client Request                    RouteX Gateway                      Pulse Node
      │                                 │                                 │
      │ 1. Sec-WebSocket-Extensions:    │                                 │
      │    permessage-deflate           │                                 │
      │────────────────────────────────>│ 2. Forward client requested     │
      │                                 │    extensions header            │
      │                                 │────────────────────────────────>│
      │                                 │                                 │ 3. Evaluate & negotiate
      │                                 │ 4. HTTP/1.1 101 Switching       │    extensions in Pulse ws
      │                                 │    Sec-WebSocket-Extensions:    │
      │                                 │    permessage-deflate; server=x │
      │                                 │<────────────────────────────────│
      │ 5. Forward negotiated extension │                                 │
      │    response header to client    │                                 │
      │<────────────────────────────────│                                 │
```

- **Client request $\rightarrow$ RouteX $\rightarrow$ Pulse**: RouteX forwards the client's requested `Sec-WebSocket-Extensions` header to Pulse.
- **Pulse response $\rightarrow$ RouteX $\rightarrow$ Client**: Pulse's WebSocket server negotiates and formats the accepted extension header; RouteX copies Pulse's negotiated response header to the client's HTTP 101 response.
- **RouteX Boundary**: RouteX does NOT modify, invent, decompress, or negotiate extensions itself.
- **Subprotocols (`Sec-WebSocket-Protocol`)**: RouteX similarly preserves incoming subprotocols (including Pulse's `token.<val>` auth format) and forwards Pulse's selected subprotocol in the 101 response.
- **Test Requirement**: Integration test asserting `Sec-WebSocket-Extensions` and `Sec-WebSocket-Protocol` presence and fidelity on both request and response paths.

---

## 4. Targeted Invariant 2: Explicit Trusted Boundary for Client IP Resolution

### The Threat & Architecture
```
Untrusted Client ───> [ RouteX Edge Gateway ] ───(Trusted Private Link)───> [ Pulse Node ]
                            │                                                     │
               1. Strips incoming untrusted XFF.             2. Checks: Is remoteAddress
               2. Sets X-Forwarded-For: <realClientIp>.         in trustedProxies list?
               3. Injects X-Gateway-Forwarded-By: routex.    3. YES: trust XFF header.
                                                                NO:  req.socket.remoteAddress
                                                                     strictly authoritative!
```

### Pulse IP Resolution Contract
- Do NOT use ambiguous "rightmost vs. leftmost" heuristics in Pulse.
- **RouteX Responsibility**:
  - For incoming requests from the public internet, RouteX strips any client-provided `X-Forwarded-For`.
  - RouteX sets `X-Forwarded-For: <clientRemoteIp>`.
- **Pulse Responsibility**:
  - Pulse introduces explicit `trustProxy: boolean` (default `false`) and `trustedProxies: string[]` (default `['127.0.0.1', '::1']`) in `PulseConfig`.
  - When a connection arrives at Pulse:
    - If `trustProxy === true` AND `trustedProxies.includes(req.socket.remoteAddress)`: Pulse trusts `req.headers['x-forwarded-for']`.
    - If request arrives directly (not through RouteX) or `trustProxy === false`: `req.socket.remoteAddress` remains **strictly authoritative**.
  - Direct public exposure of Pulse without RouteX cannot spoof client IP.

---

## 5. Targeted Invariant 3: WebSocket Upgrade State Machine & Failover Invariant

### State Machine Architecture
Avoid generic request retry helpers (`executeWithFailover<T>()`). WebSocket upgrades have distinct state transitions:

```
[ INITIALIZING ]
       │ Client upgrade request received & route validated (websocket: true)
       ▼
[ CONNECTING ] ───(Connect Error / ECONNREFUSED & retries < 1)───► [ SELECT NEXT READY NODE ]
       │                                                                      │
       │ Upstream connected & 101 Switching Protocols received                └──► [ CONNECTING ]
       ▼
[ UPGRADED ]
       │
       │ 1. Write 101 + headers (forward Pulse extensions/protocols) to client
       │ 2. Forward upstreamHead to client
       │ 3. Forward client head to upstream
       │ 4. clientSocket.setNoDelay(true), upstreamSocket.setNoDelay(true)
       │ 5. clientSocket.pipe(upstreamSocket), upstreamSocket.pipe(clientSocket)
       ▼
[ ACTIVE_TUNNEL ]  <═══════════════ STRICT INVARIANT ═══════════════>
       │                                                            │
       │   - NO RETRIES                                             │
       │   - NO UPSTREAM RESELECTION                                │
       │   - NO CONNECTION DUPLICATION                              │
       │                                                            │
       │ Socket emits error / close / end                           │
       ▼                                                            │
[ CLOSING / CLOSED ] ◄──────────────────────────────────────────────┘
       - Immediately terminate both sockets (TCP FIN)
       - Clean up active tunnel tracking
       - Client application-level reconnect logic owns reconnection
```

### Core Invariant Rules:
1. **BEFORE 101**: Connect failure / dial error (`ECONNREFUSED`, `ETIMEDOUT` before 101 response) $\rightarrow$ eligible for bounded failover to next ready node (max 1 retry).
2. **AFTER 101**: Transition to `ACTIVE_TUNNEL`. **NEVER retry, NEVER select another upstream, NEVER duplicate the connection**.
3. If the tunnel breaks mid-session, RouteX tears down both sockets cleanly.

---

## 6. Targeted Invariant 4: Physical Connection Reconnect vs. Distributed Message Delivery

### The Clarification
**Redis Pub/Sub does NOT restore a WebSocket session.**

### The Exact End-to-End Failure Flow:
```
Client
  │
  │ (Active WebSocket tunnel)
  ▼
RouteX ──> Pulse Node 1
               X
             CRASH (SIGKILL)
               │
               ▼
RouteX detects broken upstream socket
  │
  ├── Terminates client socket (TCP FIN)
  │
  ▼
Client detects socket closure (ws.on('close'))
  │
  ├── Client state machine enters RECONNECTING_BACKOFF
  ├── Computes jittered delay
  │
  ▼
Client reconnects: ws://routex:8080/ws
  │
  ▼
RouteX selects Pulse Node 2
  │
  ├── Upstream upgrade to Node 2 succeeds (101 Switching Protocols)
  ├── RouteX establishes new duplex tunnel
  │
  ▼
Client authenticated on Node 2 (New physical session created)
  │
  ├── Client-side reliability logic (PulseClientSession) sends ROOM_BATCH_JOIN
  ├── Client flushes pending un-ACKed frames from retry queue
  │
  ▼
Distributed message delivery resumes across cluster via Redis Pub/Sub
```

- **Connection Recovery**: Owned by the client (`PulseClientSession`) re-establishing a new physical connection to a surviving node via RouteX.
- **Message Delivery Continuity**: Owned by Redis Pub/Sub routing room and user events across cluster nodes.

---

## 7. Targeted Invariant 5: Native Stream Backpressure Separation

### Responsibility Separation
```
+───────────────────────────────────+       +───────────────────────────────────+
│         Pulse Responsibility      │       │        RouteX Responsibility      │
│                                   │       │                                   │
│ - Monitors socket.bufferedAmount  │       │ - Zero knowledge of frame sizes   │
│ - Evicts slow consumers if        │       │ - Zero knowledge of 64KB limits   │
│   bufferedAmount > 64KB           │       │ - Strictly pipes TCP byte streams │
│ - Sends close code 1008           │       │ - Downstream pause -> pauses read │
+─────────────────┬─────────────────+       +─────────────────┬─────────────────+
                  │                                           │
                  ▼                                           ▼
       [ Pulse Realtime Node ] ───────TCP───────> [ RouteX Duplex Pipe ] ───────TCP───────> [ Client ]
```

- RouteX does NOT inspect frames, parse payloads, or track `bufferedAmount`.
- When a client reads slowly:
  1. Downstream TCP buffer fills.
  2. `clientSocket.write()` returns `false`.
  3. Node.js stream piping automatically pauses reading from `upstreamSocket` (`upstreamSocket.pause()`).
  4. Upstream TCP buffer fills, triggering TCP zero-window throttling back to Pulse.
  5. Pulse's OS send buffer fills, causing Pulse's `socket.bufferedAmount` to climb.
  6. Pulse's `Connection.ts` detects `bufferedAmount > maxBufferedAmountBytes` and executes eviction (`socket.close(1008)`).
  7. RouteX detects upstream closure and closes `clientSocket`.
- RouteX memory stays flat solely due to native Node.js TCP stream backpressure.

---

## 8. Critical 11-Step WebSocket Upgrade Lifecycle Sequence

```text
Step 1:  Client sends GET /ws (Upgrade: websocket).
Step 2:  RouteX validates matching route (route.websocket === true) and edge rate limit.
Step 3:  RouteX selects a READY Pulse node from UpstreamHealthTracker.
Step 4:  RouteX constructs upstream upgrade request (http.request), forwarding client's
         Sec-WebSocket-Key, Sec-WebSocket-Version, Sec-WebSocket-Protocol, Sec-WebSocket-Extensions,
         and injecting X-Request-Id, X-Forwarded-For, X-Gateway-Forwarded-By: routex.
Step 5:  RouteX connects to Pulse node. (Connect failure/ECONNREFUSED -> try next ready node once).
Step 6:  RouteX receives upstream HTTP 101 Switching Protocols response.
Step 7:  RouteX writes 101 status line and response headers to client, forwarding Pulse's
         negotiated Sec-WebSocket-Accept, Sec-WebSocket-Protocol, Sec-WebSocket-Extensions.
Step 8:  RouteX forwards any upstreamHead buffer bytes to clientSocket.
Step 9:  RouteX forwards client head buffer bytes to upstreamSocket.
Step 10: RouteX sets setNoDelay(true) and initiates bidirectional stream piping:
         clientSocket.pipe(upstreamSocket) & upstreamSocket.pipe(clientSocket).
Step 11: RouteX transitions connection state to ACTIVE_TUNNEL.
         From this point forward, retry logic is 100% disabled.
```

---

## 9. Routing Contract (Zero Path Collision)

```yaml
# RouteX Route Definitions for Pulse Integration

routes:
  # 1. Realtime WebSocket Route
  - id: pulse_realtime_ws
    pathPrefix: /ws
    upstreams:
      - http://127.0.0.1:3001
      - http://127.0.0.1:3002
    stripPrefix: false
    websocket: true
    rateLimit:
      enabled: true
      windowSec: 60
      limit: 120
      failurePolicy: fail-closed
    timeouts:
      connectTimeoutMs: 2000
      responseTimeoutMs: 5000

  # 2. Pulse HTTP Administration / Metrics / Health Route
  - id: pulse_http_api
    pathPrefix: /pulse/api
    upstreams:
      - http://127.0.0.1:3001
      - http://127.0.0.1:3002
    stripPrefix: true
    methods:
      - GET
    timeouts:
      connectTimeoutMs: 1000
      responseTimeoutMs: 3000
```

- `/readyz` on RouteX returns RouteX gateway readiness (checking Redis, router, pools).
- `/pulse/api/readyz` proxies to Pulse's `/readyz` (returning Pulse cluster readiness).
- `/pulse/api/metrics` proxies to Pulse's `/metrics` (Prometheus exposition).
- `/ws` proxies realtime WebSocket handshakes to Pulse nodes.

---

## 10. Implementation Boundaries

1. **Boundary 1: RouteX RFC 6455 WebSocket Upgrade Proxy Core**
   - Implement `WebSocketProxyHandler` in `D:\RouteX\RouteX\src\proxy\websocket.ts` following the strict 11-step lifecycle.
   - Forward `head` and `upstreamHead` buffers.
   - Enforce `ACTIVE_TUNNEL` zero-retry invariant.
   - Sanitize upgrade headers in `src\proxy\headers.ts`.
   - Wire `'upgrade'` listener and tunnel shutdown tracking in `src\server\gateway-server.ts`.
2. **Boundary 2: Upstream Health Tracking & Schema Backwards Compatibility**
   - Implement `UpstreamHealthTracker` in `src\proxy\upstream-health.ts` (polling `/readyz` every 2000ms).
   - Update `RouteDefinitionSchema` in `src\config\schema.ts` to support `websocket?: boolean` and `upstreams?: string[]` (normalizing legacy single `upstream` to `[upstream]`).
3. **Boundary 3: Pulse Client IP Trusted Proxy Boundary**
   - Update `PulseConfig` and `PulseServer.ts` with `trustProxy` and `trustedProxies` check.
   - If trusted: accept sanitized `X-Forwarded-For`. If untrusted: enforce `req.socket.remoteAddress`.
   - Provide reference RouteX YAML configuration `config/routex-integration.yaml`.
4. **Boundary 4: End-to-End Integration Test Suite**
   - Vitest suite in RouteX: `tests/integration/gateway-websocket.test.ts`.
   - Jest suite in Pulse: `tests/integration/RouteXIntegration.test.ts` (covering non-empty `head`, extension/subprotocol negotiation, connect-time failover, node kill + client session reconnect, and native stream backpressure).
5. **Boundary 5: Documentation & Invariant Verification**
   - `README.md` and `PULSE_PROJECT_SPEC.md` updates reflecting the verified Phase 8 architecture.
