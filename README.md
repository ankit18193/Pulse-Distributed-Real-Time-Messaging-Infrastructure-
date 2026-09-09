# @ankit18193/pulse

> **Distributed Real-Time Messaging Infrastructure for Node.js & TypeScript**

[![npm version](https://img.shields.io/badge/npm-v0.3.0-blue.svg)](https://www.npmjs.com/package/@ankit18193/pulse)
[![license](https://img.shields.io/badge/license-Apache--2.0-green.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](package.json)

**Pulse** is a production-grade, distributed real-time messaging engine. It provides horizontally scalable WebSocket infrastructure with room-based broadcast, cluster pub/sub, Lua-powered presence tracking, message delivery acknowledgments (ACKs), UUIDv7 idempotency, and built-in resilience hardening (origin defense, rate limiting, connection bounding, and graceful draining).

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────────────┐
│                        DEVELOPER APPLICATION                           │
│                                                                        │
│   import { PulseServer } from "@ankit18193/pulse";                     │
│   const pulse = new PulseServer({ port: 8080 });                       │
│   await pulse.start();                                                 │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   @ankit18193/pulse (Public Surface)                   │
│                                                                        │
│  • PulseServer          • loadConfig          • Authenticator          │
│  • PulseServerOptions   • OriginMatcher       • generateUUIDv7         │
│  • PulseMetricsRegistry • PrometheusSerializer• Protocol Event Types   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
               Strict Private Encapsulation (Engine Internals)
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        Pulse Engine (Private)                          │
│                                                                        │
│   ConnectionManager  •  MessageDispatcher  •  PresenceManager          │
│   IdempotencyManager •  TokenBucket (Rate) •  HeartbeatManager         │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
                       Redis Cluster (Pub/Sub & Leases)
```

---

## 1. Installation

Install `@ankit18193/pulse` in your project via npm:

```bash
npm install @ankit18193/pulse
```

### Requirements
- **Node.js**: `>= 20.0.0`
- **Module Format**: ES Modules (`"type": "module"`)
- **Redis (Optional)**: Required only when running multiple distributed instances.

---

## 2. Quick Start

Create a minimal real-time WebSocket server in fewer than 10 lines of code:

```typescript
// server.ts
import { PulseServer } from '@ankit18193/pulse';

const server = new PulseServer({
  port: 8080,
  authSecret: 'pulse-dev-secret-key-32chars-min'
});

await server.start();
console.log('Pulse server listening on ws://localhost:8080');
```

Run with:
```bash
node server.ts
# or using tsx
npx tsx server.ts
```

### Standalone CLI Runner
Pulse can also be run directly as a dedicated daemon process without writing any code:

```bash
# Using npx
npx @ankit18193/pulse

# Or using the installed binary
npx pulse-server --help
```

---

## 3. Client Connection Guide

Pulse accepts standard RFC 6455 WebSocket connections from browser native `WebSocket`, Node.js `ws`, or mobile clients.

### Connecting with Authentication
Authentication tokens can be passed via:
1. **URL Query Parameter (Recommended)**: `ws://localhost:8080?token=<JWT_OR_HMAC>`
2. **HTTP Authorization Header**: `Authorization: Bearer <TOKEN>`
3. **WebSocket Subprotocol Header**: `Sec-WebSocket-Protocol: token.<TOKEN>`

#### Browser Example
```javascript
const token = "your-auth-token-from-auth-service";
const socket = new WebSocket(`ws://localhost:8080?token=${token}`);

socket.addEventListener('open', () => {
  console.log('Connected to Pulse!');

  // Join a room
  socket.send(JSON.stringify({
    eventId: crypto.randomUUID(),
    type: 'ROOM_JOIN',
    timestamp: Date.now(),
    senderId: 'user_123',
    target: { roomId: 'lobby' },
    payload: { roomId: 'lobby' }
  }));
});

socket.addEventListener('message', (event) => {
  const frame = JSON.parse(event.data);
  console.log('Received event:', frame.type, frame.payload);
});
```

#### Node.js (`ws`) Client Example
```javascript
import WebSocket from 'ws';

const ws = new WebSocket(`ws://localhost:8080?token=${token}`);

ws.on('open', () => {
  // Send a message to the room
  ws.send(JSON.stringify({
    eventId: 'msg-001',
    type: 'ROOM_MESSAGE',
    timestamp: Date.now(),
    senderId: 'user_123',
    target: { roomId: 'lobby' },
    ackRequired: true,
    payload: { text: 'Hello everyone!' }
  }));
});

ws.on('message', (data) => {
  const envelope = JSON.parse(data.toString());
  if (envelope.type === 'DELIVERY_ACK') {
    console.log('Message delivered successfully!');
  }
});
```

---

## 4. Configuration Reference

`PulseServer` resolves configuration using the following priority:
$$\text{PulseServerOptions} \longrightarrow \text{Environment Variables} \longrightarrow \text{System Defaults} \longrightarrow \text{Production Validation}$$

```typescript
const server = new PulseServer(options?: PulseServerOptions);
```

### Options & Environment Variables

| Option | Environment Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `port` | `PORT` | `8080` | Port to bind HTTP and WebSocket server. |
| `host` | `HOST` | `'0.0.0.0'` | Host address to bind. |
| `nodeEnv` | `NODE_ENV` | `'development'` | Environment (`'development'`, `'test'`, `'production'`). |
| `instanceId` | `INSTANCE_ID` | `'pulse-node-1'` | Unique instance node identifier in a cluster. |
| `authSecret` | `AUTH_SECRET` | `'pulse-dev-secret-key-32chars-min'` | HMAC secret key used for authentication. |
| `redisEnabled` | `REDIS_ENABLED` | `false` | Enable Redis cluster pub/sub and presence. |
| `redisUrl` | `REDIS_URL` | `undefined` | Redis connection URL (e.g. `redis://127.0.0.1:6379`). |
| `redisHost` | `REDIS_HOST` | `'127.0.0.1'` | Redis host (if not using `redisUrl`). |
| `redisPort` | `REDIS_PORT` | `6379` | Redis port. |
| `maxConnections` | `MAX_CONNECTIONS` | `10000` | Hard cap on concurrent active connections. |
| `maxRoomsPerConnection` | `MAX_ROOMS_PER_CONNECTION` | `100` | Max rooms a single connection may join. |
| `maxRoomIdLength` | `MAX_ROOM_ID_LENGTH` | `128` | Maximum room identifier character length. |
| `allowedOrigins` | `ALLOWED_ORIGINS` | `['*']` (dev) | Comma-separated allowed Origin headers for CSWSH defense. |
| `inboundRateLimitMax` | `INBOUND_RATE_LIMIT_MAX` | `100` | Refill tokens per second per connection. |
| `inboundRateLimitBurst` | `INBOUND_RATE_LIMIT_BURST` | `50` | Maximum burst token bucket capacity per socket. |
| `drainTimeoutMs` | `DRAIN_TIMEOUT_MS` | `2000` | Graceful shutdown connection draining window in ms. |
| `heartbeatIntervalMs` | `HEARTBEAT_INTERVAL_MS`| `30000` | WebSocket ping heartbeat interval in ms. |
| `heartbeatTimeoutMs` | `HEARTBEAT_TIMEOUT_MS` | `10000` | Unresponsive connection reaper timeout in ms. |
| `metricsEnabled` | `METRICS_ENABLED` | `true` | Expose Prometheus metrics on `/metrics`. |
| `metricsPath` | `METRICS_PATH` | `'/metrics'` | Path for Prometheus exposition endpoint. |

---

## 5. Authentication

Pulse includes a built-in cryptographic `Authenticator` that generates and validates HMAC-SHA256 tokens in constant time:

```typescript
import { Authenticator } from '@ankit18193/pulse';

const authenticator = new Authenticator(process.env.AUTH_SECRET);

// 1. Generate an authentication token for a user
const token = authenticator.generateToken({
  userId: 'user_alice_123',
  roles: ['member', 'moderator'],
  expiresInSeconds: 3600 // 1 hour
});

// 2. Verify an incoming token
const result = authenticator.verifyToken(token);
if (result.authenticated) {
  console.log(`User ID: ${result.userId}, Roles: ${result.roles}`);
}
```

### Production Security Gate
When `NODE_ENV === 'production'`:
- `AUTH_SECRET` must be explicitly configured and at least **32 characters long**.
- Known development fallback secrets are rejected at server bootstrap.

---

## 6. Rooms & Subscriptions

Pulse supports dynamic room creation, message fan-out, and auto-cleanup.

### Subscribing to Rooms
Clients join rooms by sending a `ROOM_JOIN` event:
```json
{
  "eventId": "01a0854b-24ac-7058-8605-a6cf1d1c2189",
  "type": "ROOM_JOIN",
  "timestamp": 1725883200000,
  "senderId": "user_123",
  "target": { "roomId": "chat-engineering" },
  "payload": { "roomId": "chat-engineering" }
}
```
Server responds with `ROOM_JOIN_ACK`.

### Batch Room Joins
Clients reconnecting after network drops can restore multiple rooms atomically using `ROOM_BATCH_JOIN`:
```json
{
  "eventId": "batch-join-01",
  "type": "ROOM_BATCH_JOIN",
  "timestamp": 1725883200000,
  "senderId": "user_123",
  "payload": { "rooms": ["chat-engineering", "announcements", "alerts"] }
}
```

### Room Bounding
To protect memory against subscription exhaustion attacks:
- Sockets attempting to exceed `MAX_ROOMS_PER_CONNECTION` (default 100) receive `SYS_ERROR: ROOM_LIMIT_EXCEEDED`.
- Room IDs exceeding `MAX_ROOM_ID_LENGTH` (default 128 characters) are rejected with `SYS_ERROR: INVALID_ROOM_ID`.

---

## 7. Messaging, Idempotency & ACKs

### Event Envelope Format (`PulseEventEnvelope`)
All frames flowing through Pulse conform to a strict TypeScript envelope:

```typescript
interface PulseEventEnvelope<T = unknown> {
  eventId: string;           // RFC 9562 UUIDv7 or unique ID
  type: EventType;           // 'ROOM_MESSAGE', 'DIRECT_MESSAGE', etc.
  timestamp: number;         // Millisecond timestamp
  senderId: string;          // Authenticated sender user ID
  target?: {
    roomId?: string;         // Target room for broadcast
    recipientId?: string;    // Target user for direct message
  };
  payload: T;                // Arbitrary JSON payload
  correlationId?: string;    // Optional correlation tracing ID
  ackRequired?: boolean;     // Request delivery acknowledgment
}
```

### Deduplication & Idempotency
Pulse maintains an in-memory LRU ring cache (10,000 capacity, 60s TTL) keyed by `eventId`:
- Duplicate messages with identical `eventId` are suppressed from re-broadcasting.
- If `ackRequired` was true, the original `DELIVERY_ACK` is replayed to the client.
- Conflicting payload reuse of an existing `eventId` is rejected with `SYS_ERROR: EVENT_ID_CONFLICT`.

### Delivery Acknowledgment (`DELIVERY_ACK`)
When a client sends a message with `"ackRequired": true`, Pulse delivers the message to the target room and transmits a confirmation back to the sender:
```json
{
  "eventId": "01a0854b-666b-73f2-8a2e-fc0c10b8beac",
  "type": "DELIVERY_ACK",
  "timestamp": 1725883201000,
  "senderId": "pulse-node-1",
  "correlationId": "msg-alice-101",
  "payload": {
    "status": "DELIVERED",
    "receivedCount": 3
  }
}
```

---

## 8. Distributed Presence Engine

When Redis is enabled, Pulse runs an active presence tracking engine that aggregates multi-device user sessions across nodes using atomic Redis Lua scripts.

```typescript
import { PulseServer } from '@ankit18193/pulse';

const server = new PulseServer({
  redisEnabled: true,
  redisUrl: 'redis://127.0.0.1:6379',
  presenceTtlMs: 60000,        // Ephemeral lease TTL
  presenceFlushIntervalMs: 15000 // Renewal heartbeat interval
});
```

- **Online Transition**: Emitted when a user connects their first socket.
- **Offline Transition**: Emitted when a user disconnects their last remaining device or their lease expires.
- **Room Rosters**: Query online users within a specific room via `ROOM_ROSTER`.

---

## 9. Redis Multi-Node Clustering

Pulse scales horizontally by connecting multiple server nodes to a shared Redis instance or cluster:

```bash
# Node 1
PORT=8081 INSTANCE_ID=pulse-1 REDIS_ENABLED=true REDIS_URL=redis://localhost:6379 npx pulse-server

# Node 2
PORT=8082 INSTANCE_ID=pulse-2 REDIS_ENABLED=true REDIS_URL=redis://localhost:6379 npx pulse-server
```

### Clustering Guarantees
- **Reference-Counted Channels**: Redis subscriptions are created only when a local socket joins a room and freed when the last socket leaves.
- **Loopback Suppression**: Nodes tag published frames with `originInstanceId` and drop their own echoes to prevent double delivery.
- **Backpressure Protection**: Inbound and outbound buffers drop saturated sockets exceeding `MAX_BUFFERED_AMOUNT_BYTES` (default 1MB).

---

## 10. RouteX Gateway Integration

Pulse natively integrates with [@ankit18193/routex-gateway](https://www.npmjs.com/package/@ankit18193/routex-gateway) for edge routing, pre-101 failover, and reverse proxying:

```typescript
import { PulseServer } from '@ankit18193/pulse';
import { RouteXGatewayServer } from '@ankit18193/routex-gateway';

const routex = new RouteXGatewayServer({
  routes: [
    { prefix: '/api', upstream: 'http://internal-api:3000' }
  ]
});

const server = new PulseServer(
  { port: 8080 },
  {},
  { routexGateway: routex }
);

await server.start();
```

---

## 11. Production Hardening & Security

Every instance of Pulse incorporates the Phase 10 security invariants:

1. **Cross-Site WebSocket Hijacking (CSWSH) Defense**:
   Incoming handshakes are evaluated against `allowedOrigins`. In production, wildcard `*` is disallowed.
2. **Inbound Token Bucket Rate Limiting**:
   Sockets are metered with a token bucket (`INBOUND_RATE_LIMIT_MAX` refill rate, `INBOUND_RATE_LIMIT_BURST` capacity). Sockets exceeding limits receive `SYS_ERROR: RATE_LIMIT_EXCEEDED`; abusive sockets are closed with RFC 6455 Policy Violation (`code: 1008`).
3. **Atomic Connection Admission**:
   Handshake requests reserve connection slots atomically before socket upgrade. Over-capacity requests are rejected with `HTTP 503 Service Unavailable`.
4. **Graceful Draining & Process Traps**:
   On `SIGINT` or `SIGTERM`, Pulse enters draining mode: stops accepting new handshakes, broadcasts `SYS_SHUTDOWN` frames, and gracefully drains existing connections over `DRAIN_TIMEOUT_MS` before terminating.

---

## 12. Observability & Prometheus Metrics

Pulse exposes production metrics on `GET /metrics` formatted for Prometheus:

```bash
curl http://localhost:8080/metrics
```

### Key Metrics
- `pulse_connections_total`: Total connections by status (`accepted`, `rejected`).
- `pulse_connections_active`: Current active WebSocket sockets.
- `pulse_messages_received_total`: Inbound messages by event type.
- `pulse_messages_delivered_total`: Outbound messages by event type.
- `pulse_rate_limit_exceeded_total`: Messages dropped due to token bucket rate limits.
- `pulse_event_loop_lag_seconds`: Mean, p50, and p99 Node.js event-loop lag.
- `pulse_presence_users_online`: Distinct online users in cluster.

### Health Probes
- `GET /health`: Overall server health and uptime status.

---

## 13. Troubleshooting & FAQs

### Q: Why do I get HTTP 401 on connect?
Ensure an authentication token is provided in the query string (`ws://localhost:8080?token=<TOKEN>`) or `Authorization: Bearer <TOKEN>` header.

### Q: Why does the server throw `AUTH_SECRET must be at least 32 characters long`?
When `NODE_ENV=production`, Pulse enforces cryptographic secret length to prevent brute-force token forgery. Set a secure secret of at least 32 characters.

### Q: How do I run Pulse without Redis?
Simply leave `REDIS_ENABLED=false` (the default). Pulse will operate as a standalone, zero-dependency real-time engine.

---

## License

Apache License 2.0. See [LICENSE](LICENSE) for details.
