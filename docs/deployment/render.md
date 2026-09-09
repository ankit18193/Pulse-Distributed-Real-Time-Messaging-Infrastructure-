# Pulse Infrastructure — Production Deployment to Render

This runbook describes the production deployment of the **Pulse Distributed Real-Time Messaging Infrastructure** to [Render](https://render.com).

Pulse is packaged as a cloud-native, distributed WebSocket messaging engine that binds HTTP REST, Prometheus metrics, and WebSocket transports onto a single Node.js runtime, backed by Redis for multi-node clustering and presence synchronization.

---

## 1. Architecture Overview

```
                      Internet Clients / Browsers
                                  │
                                  ▼
                    ┌───────────────────────────┐
                    │     Render Edge Proxy     │
                    │   (TLS Termination, DDOS) │
                    └─────────────┬─────────────┘
                                  │  X-Forwarded-For / HTTPS / WSS
                                  ▼
         ┌─────────────────────────────────────────────────┐
         │       Pulse Web Service (Render Web Service)    │
         │                                                 │
         │  Port: $PORT (Dynamic 10000 or Render-assigned) │
         │                                                 │
         │  ├── HTTP Endpoints                             │
         │  │   ├── GET /healthz   (Liveness probe)        │
         │  │   ├── GET /readyz    (Readiness probe)       │
         │  │   ├── GET /metrics   (Prometheus scrape)     │
         │  │   ├── GET /api/stats (Telemetry JSON)        │
         │  │   └── GET /dashboard/(Embedded Mission Ctrl) │
         │  │                                              │
         │  └── WebSocket Engine                           │
         │      └── Upgrade /ws    (Subprotocol, Frames)   │
         └────────────────────────┬────────────────────────┘
                                  │  Internal Private Mesh (redis://)
                                  ▼
         ┌─────────────────────────────────────────────────┐
         │       Pulse Redis (Render Key Value Service)    │
         │  ├── Pub/Sub Channel Broadcasts                 │
         │  ├── Ephemeral Connection Presence Leases       │
         │  └── Distributed Cluster State                  │
         └─────────────────────────────────────────────────┘
```

### Components

| Component | Render Service Type | Role |
| :--- | :--- | :--- |
| **Pulse Server** | Web Service (Node.js) | Core messaging server, WebSocket transport, metrics, HTTP endpoints, embedded dashboard |
| **Pulse Redis** | Key Value (Redis 7) | Cross-node pub/sub message broadcast, presence leases, and clustering |
| **Mission Control Dashboard** | Web Service / Static Site | Standalone Vite React SPA for visual cluster telemetry and traffic sandbox (also available embedded on the server at `/dashboard/`) |

---

## 2. Deployment Option A: Infrastructure-as-Code (Render Blueprint)

The repository includes a ready-to-use Render Blueprint file ([render.yaml](file:///d:/Pulse/Pulse-Distributed-Real-Time-Messaging-Infrastructure-/render.yaml)). This is the recommended, zero-drift method.

### Steps:
1. Push your repository to GitHub or GitLab.
2. Log into the [Render Dashboard](https://dashboard.render.com).
3. Click **New +** → **Blueprint**.
4. Connect your Git repository.
5. Render will detect `render.yaml` and plan 3 resources:
   - `pulse-redis` (Redis Key-Value)
   - `pulse-server` (Web Service)
   - `pulse-dashboard` (Static Site)
6. Click **Apply**.
7. Render will automatically provision the Redis instance, wire the `REDIS_URL` connection string to the Web Service, generate a secure `AUTH_SECRET`, and build both services.

---

## 3. Deployment Option B: Manual Setup via Render Dashboard

If you prefer provisioning services manually through the Render UI:

### Step 1: Provision Redis Key-Value Store
1. In Render Dashboard, click **New +** → **Redis**.
2. **Name**: `pulse-redis`
3. **Plan**: `Starter` (or `Free`)
4. **IP Allow List**: Leave blank / internal mesh only.
5. Click **Create Redis**.
6. Once provisioned, note the **Internal Redis URL** (`redis://red-xxxxxxxx:6379`).

### Step 2: Provision Pulse Web Service
1. Click **New +** → **Web Service**.
2. Connect your Git repository.
3. Configure settings:
   - **Name**: `pulse-server`
   - **Region**: Same region as your Redis instance (critical for low latency).
   - **Branch**: `main` (or your active release branch).
   - **Runtime**: `Node`
   - **Build Command**: `npm ci && npm run build && npm run build:dashboard`
   - **Start Command**: `npm start`
   - **Plan**: `Starter`
4. Expand **Advanced Settings**:
   - **Health Check Path**: `/healthz`
5. Configure **Environment Variables**:

| Variable | Value | Purpose |
| :--- | :--- | :--- |
| `NODE_ENV` | `production` | Enables production optimizations & security rules |
| `REDIS_ENABLED` | `true` | Enables distributed clustering via Redis |
| `REDIS_URL` | `redis://red-xxxxxxxx:6379` *(from Step 1)* | Internal Redis connection URI |
| `AUTH_SECRET` | *(Random 32+ character string)* | Secures internal tokens and cluster authentication |
| `ALLOWED_ORIGINS` | `*` *(or specific domain URLs)* | Allowed CORS & WebSocket browser origins |
| `TRUST_PROXY` | `true` | Instructs server to trust Render's `X-Forwarded-For` header |
| `DRAIN_TIMEOUT_MS` | `15000` | Graceful connection draining window during redeployments |
| `MAX_CONNECTIONS` | `10000` | Max concurrent WebSocket connections per instance |
| `INBOUND_RATE_LIMIT_MAX` | `100` | Max frames per second per connection |
| `INBOUND_RATE_LIMIT_BURST`| `50` | Allowed burst frame allowance |

6. Click **Create Web Service**.

### Step 3 (Optional): Provision Standalone Mission Control Static Site
> **Note**: The dashboard is already embedded and served directly by the backend at `https://<your-pulse-server>.onrender.com/dashboard/`. Provision this step only if you prefer a standalone static site.

1. Click **New +** → **Static Site**.
2. Connect your Git repository.
3. Settings:
   - **Name**: `pulse-dashboard`
   - **Root Directory**: `dashboard`
   - **Build Command**: `npm install && npm run build`
   - **Publish Directory**: `dist`
4. Under **Redirects/Rewrites**:
   - Add a rewrite: `/*` → `/index.html` (Status: `Rewrite`).
5. Environment Variables:
   - `VITE_API_URL`: `https://pulse-server.onrender.com`
   - `VITE_WS_URL`: `wss://pulse-server.onrender.com/ws`
6. Click **Create Static Site**.

---

## 4. Environment Variables Reference

### Critical Production Security Rules

> [!WARNING]
> **Production Origin Allowlist (`ALLOWED_ORIGINS`)**
> When `NODE_ENV=production`, Pulse enforces strict origin checks on all WebSocket upgrade requests. If `ALLOWED_ORIGINS` is not set, it defaults to an empty array `[]`, causing **all browser WebSocket connections to be rejected with HTTP 403 Forbidden**.
> Always configure `ALLOWED_ORIGINS=*` (or a comma-separated list of your client domains, e.g. `https://pulse-dashboard.onrender.com,https://myapp.com`).

> [!CAUTION]
> **Authentication Secret (`AUTH_SECRET`)**
> In `production` mode, `AUTH_SECRET` must be at least **32 characters long** and cannot be left as a default development key. If this constraint is violated, Pulse will fail fast at startup to prevent running with insecure credentials.

> [!IMPORTANT]
> **Reverse Proxy Header Trust (`TRUST_PROXY`)**
> Render terminates TLS at the edge and forwards client traffic via HTTP/WebSocket to your service. Set `TRUST_PROXY=true` so Pulse reads the client's real IP address from `X-Forwarded-For` rather than Render's internal proxy IP.

---

## 5. Post-Deployment Verification Runbook

Run these commands against your deployed Render URL (e.g. `https://pulse-server.onrender.com`):

### 1. Liveness Check
```bash
curl -i https://pulse-server.onrender.com/healthz
```
**Expected Response:**
```http
HTTP/2 200
content-type: application/json
```
```json
{
  "status": "OK",
  "instanceId": "pulse-node-1",
  "timestamp": 1788947407475,
  "connections": 0,
  "rooms": 0,
  "idempotencyCacheSize": 0,
  "redis": { "enabled": true },
  "presence": { "enabled": true, "mode": "distributed" }
}
```

### 2. Readiness Check (Redis Cluster Health)
```bash
curl -i https://pulse-server.onrender.com/readyz
```
**Expected Response:**
```http
HTTP/2 200
content-type: application/json
```
```json
{
  "status": "OK",
  "instanceId": "pulse-node-1",
  "timestamp": 1788947407475,
  "redis": { "connected": true }
}
```

### 3. Prometheus Metrics Endpoint
```bash
curl -s https://pulse-server.onrender.com/metrics | grep pulse_
```
**Expected Output:**
```text
pulse_active_connections 0
pulse_messages_received_total 0
pulse_messages_delivered_total 0
```

### 4. Telemetry API Endpoint
```bash
curl -s https://pulse-server.onrender.com/api/stats
```
**Expected Output:** JSON payload with active connections, cluster node counts, and throughput statistics.

### 5. Mission Control Dashboard Access
Open the embedded dashboard in your browser:
```
https://pulse-server.onrender.com/dashboard/
```
Verify:
- System Status displays `HEALTHY` (green beacon).
- Cluster node cards render with live memory and connection metrics.
- Traffic Sandbox allows opening a WebSocket connection to `wss://pulse-server.onrender.com/ws` and publishing frames.

### 6. WebSocket Functional Test via CLI
Using `wscat` (provide valid HMAC-SHA256 token generated with your `AUTH_SECRET`):
```bash
npx wscat -c "wss://pulse-server.onrender.com/ws?token=<YOUR_TOKEN>"
```
Upon connection, server replies with `SYS_CONNECT_ACK`:
```json
{"type":"SYS_CONNECT_ACK","eventId":"...","timestamp":1788947407500}
```
Send a room join frame:
```json
{"eventId":"join-1","type":"ROOM_JOIN","timestamp":1788947407505,"senderId":"alice","target":{"roomId":"lobby"},"payload":{"roomId":"lobby"}}
```
Server confirms with:
```json
{"type":"ROOM_JOIN_ACK","targetEventId":"join-1","room":"lobby"}
```
Send a broadcast message:
```json
{"eventId":"msg-1","type":"ROOM_MESSAGE","timestamp":1788947407510,"senderId":"alice","target":{"roomId":"lobby"},"payload":{"greeting":"Hello Render"},"ackRequired":true}
```
Server acknowledges receipt with `DELIVERY_ACK`:
```json
{"type":"DELIVERY_ACK","payload":{"targetEventId":"msg-1","status":"ACCEPTED"}}
```

---

## 6. High Availability and Scale-Out

1. **Horizontal Scaling**:
   - In Render Dashboard → `pulse-server` → **Scaling**.
   - Increase instance count from 1 to 2+ instances.
   - Because `REDIS_ENABLED=true` is enabled, all Pulse instances automatically join the distributed mesh:
     - Messages published to Node A are immediately forwarded across Redis Pub/Sub to Node B.
     - Presence heartbeats synchronize across the cluster.
     - Clients connected to different nodes can communicate seamlessly.

2. **Zero-Downtime Deploys**:
   - Render automatically performs rolling deployments.
   - When a deploy starts, Render launches the new container and waits for `/healthz` to return 200 OK before routing traffic to it.
   - The old container receives `SIGTERM`, initiates graceful draining (`DRAIN_TIMEOUT_MS=15000`), notifies active WebSocket clients to reconnect to the new node, and exits cleanly.

---

## 7. Troubleshooting

| Issue | Likely Cause | Solution |
| :--- | :--- | :--- |
| WebSocket connects, then immediately closes with 403 | Origin header blocked by allowlist | Set `ALLOWED_ORIGINS=*` in Render Environment Variables. |
| Server crashes immediately at startup with `AUTH_SECRET must be at least 32 characters long` | Default or weak `AUTH_SECRET` | Generate a 32+ character random string in Render Environment Variables. |
| `/readyz` returns 503 Service Unavailable | Cannot connect to Redis | Verify `REDIS_URL` matches the internal Redis connection string. Ensure both services are in the same Render region. |
| Client IP addresses appear identical for all connections | Reverse proxy headers not trusted | Set `TRUST_PROXY=true` in Render Environment Variables. |
| Free tier spins down after inactivity | Render Free Web Service idle sleep | Upgrade to Render `Starter` plan ($7/mo) for 24/7 uninterrupted persistent WebSocket connections. |
