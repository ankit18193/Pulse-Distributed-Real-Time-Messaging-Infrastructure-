import http from 'http';
import net from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import { PulseServer } from '../../src/core/PulseServer.js';
import { loadConfig } from '../../src/config/index.js';
import { Authenticator } from '../../src/auth/Authenticator.js';
import { PulseEventEnvelope } from '../../src/types/index.js';

// Native ESM import helper to load compiled RouteX gateway server in ts-jest
const dynamicImport = new Function('u', 'return import(u)');

describe('Embedded RouteX ↔ Pulse Single-Port Integration Suite', () => {
  const testPort = 9550;
  const upstreamPort = 9551;
  const authSecret = 'pulse-embedded-routex-secret-32chars!!';
  const authenticator = new Authenticator(authSecret);

  let upstreamHttpServer: http.Server;
  let upstreamWss: WebSocketServer;
  let pulseServer: PulseServer;
  let gateway: any;
  const openSockets = new Set<WebSocket | net.Socket>();

  beforeAll(async () => {
    const routeXModule = await dynamicImport('file:///D:/RouteX/RouteX/dist/src/server/gateway-server.js');
    const RouteXGatewayServer = routeXModule.RouteXGatewayServer;
    // 1. Start Mock Upstream Server (handles both HTTP /api/hello and WS /ws-upstream)
    await new Promise<void>((resolve, reject) => {
      upstreamHttpServer = http.createServer((req, res) => {
        const rawUrl = req.url ?? '/';
        const pathname = rawUrl.split('?')[0];

        if (pathname === '/api/hello' || pathname === '/proxy/api/hello') {
          const body = JSON.stringify({
            message: 'hello from upstream',
            url: req.url,
            headers: req.headers
          });
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          });
          res.end(body);
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Upstream Not Found' }));
      });

      upstreamWss = new WebSocketServer({ noServer: true });
      upstreamWss.on('connection', (ws) => {
        ws.on('message', (data, isBinary) => {
          // Echo message back with upstream prefix
          const msg = isBinary ? data : data.toString();
          ws.send(`echo:${msg}`);
        });
      });

      upstreamHttpServer.on('upgrade', (req, socket, head) => {
        upstreamWss.handleUpgrade(req, socket, head, (ws) => {
          upstreamWss.emit('connection', ws, req);
        });
      });

      upstreamHttpServer.listen(upstreamPort, '127.0.0.1', () => {
        resolve();
      });
      upstreamHttpServer.on('error', reject);
    });

    // 2. Instantiate RouteX Gateway in EMBEDDED mode
    gateway = new RouteXGatewayServer(
      {
        server: {
          port: 8080, // Note: port is unused in embedded mode, but required by schema
          host: '127.0.0.1',
          requestTimeoutMs: 5000,
          headersTimeoutMs: 6000,
          maxHeaderSize: 16384,
          logLevel: 'silent',
          logFormat: 'json',
          trustedProxies: ['127.0.0.1'],
        },
        redis: {
          enabled: false, // In-memory rate limiting and circuit breakers
        },
        routes: [
          {
            id: 'mock-upstream-http',
            pathPrefix: '/proxy/api',
            upstream: `http://127.0.0.1:${upstreamPort}`,
            stripPrefix: false,
            websocket: false,
            methods: ['GET', 'POST'],
            auth: { mode: 'public', requiredRoles: [] },
            timeouts: { connectTimeoutMs: 1000, responseTimeoutMs: 2000 },
          },
          {
            id: 'mock-upstream-ws',
            pathPrefix: '/proxy/ws',
            upstream: `http://127.0.0.1:${upstreamPort}`,
            stripPrefix: false,
            websocket: true,
            methods: ['GET'],
            auth: { mode: 'public', requiredRoles: [] },
            timeouts: { connectTimeoutMs: 1000, responseTimeoutMs: 2000 },
          },
        ],
      },
      {
        embedded: true,
        logger: false,
      }
    );

    // 3. Instantiate PulseServer with the embedded gateway on testPort
    const pulseConfig = loadConfig({
      port: testPort,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'pulse-embedded-node-1',
      authSecret,
      trustProxy: true,
      trustedProxies: ['127.0.0.1', '::1', '::ffff:127.0.0.1'],
      metricsEnabled: true,
      redisEnabled: false, // test in isolated local mode
    });

    pulseServer = new PulseServer(pulseConfig, {}, { routexGateway: gateway });
    await pulseServer.start();
  }, 15000);

  afterAll(async () => {
    // Clean up open test sockets
    for (const s of openSockets) {
      if (s instanceof WebSocket) {
        if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING) {
          s.terminate();
        }
      } else if (!s.destroyed) {
        s.destroy();
      }
    }
    openSockets.clear();

    // Close pulse server
    if (pulseServer) {
      await pulseServer.stop({ gracePeriodMs: 500 });
    }

    // Close mock upstream
    if (upstreamWss) {
      await new Promise<void>((resolve) => upstreamWss.close(() => resolve()));
    }
    if (upstreamHttpServer) {
      await new Promise<void>((resolve) => upstreamHttpServer.close(() => resolve()));
    }
  }, 10000);

  test('Single Port: GET /proxy/api/hello delegates to RouteX and proxies to upstream', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/proxy/api/hello`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.message).toBe('hello from upstream');
    expect(data.url).toContain('/proxy/api/hello');
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  test('Single Port: GET /healthz falls through cleanly to native Pulse health check', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/healthz`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.status).toBe('OK');
    expect(data.instanceId).toBe('pulse-embedded-node-1');
    expect(data.connections).toBe(0);
  });

  test('Single Port: GET /metrics falls through cleanly to native Pulse metrics endpoint', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/metrics`);
    expect(res.status).toBe(200);

    const text = await res.text();
    expect(text).toContain('# HELP pulse_');
    expect(text).toContain('pulse_event_loop_lag_seconds');
  });

  test('Single Port: GET /unmatched-random-route falls through to Pulse 404', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/some-unmatched-url`);
    expect(res.status).toBe(404);

    const data = await res.json();
    expect(data.error).toBe('Not Found');
  });

  test('Single Port: WebSocket /proxy/ws delegates to RouteX and tunnels to upstream', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}/proxy/ws`);
    openSockets.add(ws);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    const echoPromise = new Promise<string>((resolve) => {
      ws.on('message', (msg) => {
        resolve(msg.toString());
      });
    });

    ws.send('pulse-embedded-test-message');
    const reply = await echoPromise;
    expect(reply).toBe('echo:pulse-embedded-test-message');

    ws.close();
  });

interface ConnectAckPayload {
  connectionId: string;
  userId: string;
  instanceId: string;
  connectedAt: number;
}

  test('Single Port: WebSocket / with JWT falls through to native Pulse room engine', async () => {
    const token = authenticator.generateToken({ userId: 'test-user-100', roles: ['user'], expiresInMs: 60000 });
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}/?token=${token}`);
    openSockets.add(ws);

    // Attach message listener immediately so early SYS_CONNECT_ACK is not missed
    const ackPromise = new Promise<PulseEventEnvelope<ConnectAckPayload>>((resolve) => {
      ws.on('message', (raw) => {
        const parsed = JSON.parse(raw.toString()) as PulseEventEnvelope<ConnectAckPayload>;
        if (parsed.type === 'SYS_CONNECT_ACK') {
          resolve(parsed);
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    const ackEnvelope = await ackPromise;
    expect(ackEnvelope.type).toBe('SYS_CONNECT_ACK');
    expect(ackEnvelope.payload.userId).toBe('test-user-100');
    expect(ackEnvelope.payload.instanceId).toBe('pulse-embedded-node-1');

    ws.close();
  });

  test('Single Port: WebSocket / without JWT is rejected by Pulse with 401 Unauthorized', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}/`);
    openSockets.add(ws);

    const statusCode = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 0);
      });
      ws.on('error', () => {
        // Socket closed after 401
      });
    });

    expect(statusCode).toBe(401);
  });

  test('Concurrency: 50 interleaved concurrent upgrades (25 proxy + 25 native) complete with zero corruption', async () => {
    const totalConns = 50;
    const promises: Promise<void>[] = [];

    for (let i = 0; i < totalConns; i++) {
      if (i % 2 === 0) {
        // Even index: RouteX proxy tunnel
        promises.push(
          new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${testPort}/proxy/ws`);
            openSockets.add(ws);

            ws.on('open', () => {
              ws.on('message', (msg) => {
                if (msg.toString() === `echo:interleave-${i}`) {
                  ws.close();
                  resolve();
                }
              });
              ws.send(`interleave-${i}`);
            });
            ws.on('error', reject);
          })
        );
      } else {
        // Odd index: Pulse native room engine
        const userId = `interleave-user-${i}`;
        const token = authenticator.generateToken({ userId, roles: ['user'], expiresInMs: 60000 });

        promises.push(
          new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${testPort}/?token=${token}`);
            openSockets.add(ws);

            ws.on('message', (raw) => {
              const envelope = JSON.parse(raw.toString()) as PulseEventEnvelope<ConnectAckPayload>;
              if (envelope.type === 'SYS_CONNECT_ACK' && envelope.payload.userId === userId) {
                ws.close();
                resolve();
              }
            });
            ws.on('error', reject);
          })
        );
      }
    }

    // Await all 50 interleaved concurrent connections
    await Promise.all(promises);
  }, 20000);
});
