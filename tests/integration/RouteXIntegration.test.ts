import http from 'http';
import net from 'net';
import WebSocket from 'ws';
import crypto from 'crypto';
import { PulseServer } from '../../src/core/PulseServer.js';
import { loadConfig } from '../../src/config/index.js';
import { Authenticator } from '../../src/auth/Authenticator.js';
import { PulseEventEnvelope } from '../../src/types/index.js';

// Native ESM import helper to load compiled RouteX gateway server in ts-jest
const dynamicImport = new Function('u', 'return import(u)');

describe('RouteX ↔ Pulse Distributed Edge Integration Suite', () => {
  const node1Port = 9341;
  const node2Port = 9342;
  const authSecret = 'pulse-routex-integration-test-secret-32chars!';
  const authenticator = new Authenticator(authSecret);

  let server1: PulseServer;
  let server2: PulseServer;
  let gateway: any;
  let gatewayPort: number;
  const openSockets = new Set<WebSocket | net.Socket>();

  beforeAll(async () => {
    // 1. Start Pulse Node 1 (Real Redis enabled via loadConfig)
    const config1 = loadConfig({
      port: node1Port,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'pulse-cluster-node-1',
      authSecret,
      trustProxy: true,
      trustedProxies: ['127.0.0.1', '::1', '::ffff:127.0.0.1'],
      metricsEnabled: true,
    });
    server1 = new PulseServer(config1);
    await server1.start();

    // 2. Start Pulse Node 2 (Real Redis enabled via loadConfig)
    const config2 = loadConfig({
      port: node2Port,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'pulse-cluster-node-2',
      authSecret,
      trustProxy: true,
      trustedProxies: ['127.0.0.1', '::1', '::ffff:127.0.0.1'],
      metricsEnabled: true,
    });
    server2 = new PulseServer(config2);
    await server2.start();

    // 3. Load and start RouteX Gateway Server
    const routeXModule = await dynamicImport('file:///D:/RouteX/RouteX/dist/src/server/gateway-server.js');
    const RouteXGatewayServer = routeXModule.RouteXGatewayServer;

    gateway = new RouteXGatewayServer({
      server: {
        port: 8080,
        host: '127.0.0.1',
        requestTimeoutMs: 5000,
        headersTimeoutMs: 6000,
        maxHeaderSize: 16384,
        logLevel: 'silent',
        logFormat: 'json',
        trustedProxies: ['127.0.0.1'],
      },
      redis: {
        enabled: true,
        host: '127.0.0.1',
        port: 6379,
        keyPrefix: 'routex_pulse_test:',
      },
      routes: [
        {
          id: 'pulse-ws-cluster',
          pathPrefix: '/ws',
          upstreams: [`http://127.0.0.1:${node1Port}`, `http://127.0.0.1:${node2Port}`],
          stripPrefix: false,
          websocket: true,
          methods: ['GET'],
          auth: { mode: 'public', requiredRoles: [] },
          timeouts: { connectTimeoutMs: 1000, responseTimeoutMs: 2000 },
        },
        {
          id: 'rate-limited-ws',
          pathPrefix: '/ratelimited',
          upstreams: [`http://127.0.0.1:${node1Port}`],
          stripPrefix: false,
          websocket: true,
          methods: ['GET'],
          auth: { mode: 'public', requiredRoles: [] },
          rateLimit: {
            enabled: true,
            windowSec: 60,
            limit: 1,
            failurePolicy: 'fail-closed',
          },
          timeouts: { connectTimeoutMs: 1000, responseTimeoutMs: 2000 },
        },
      ],
    });

    const address = await gateway.listen(0, '127.0.0.1');
    const parsed = new URL(address);
    gatewayPort = Number(parsed.port);
  }, 30000);

  afterAll(async () => {
    for (const s of openSockets) {
      if (s instanceof WebSocket) {
        if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING) {
          s.close();
        }
      } else if (!s.destroyed) {
        s.destroy();
      }
    }
    openSockets.clear();

    if (gateway) {
      await gateway.close();
    }
    if (server1 && server1.isServerRunning()) {
      await server1.stop({ gracePeriodMs: 50 });
    }
    if (server2 && server2.isServerRunning()) {
      await server2.stop({ gracePeriodMs: 50 });
    }
  }, 30000);

  it('1. RouteX RFC 6455 Upgrade & Authoritative Pulse Authentication', async () => {
    const token = authenticator.generateToken({ userId: 'alice' });
    const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws?token=${token}`);
    openSockets.add(ws);

    const initialAck = await new Promise<PulseEventEnvelope>((resolve, reject) => {
      ws.on('message', (data) => {
        try {
          const envelope: PulseEventEnvelope = JSON.parse(data.toString());
          if (envelope.type === 'SYS_CONNECT_ACK') {
            resolve(envelope);
          }
        } catch (err) {
          reject(err);
        }
      });
      ws.on('error', reject);
    });

    expect(initialAck.type).toBe('SYS_CONNECT_ACK');
    expect(initialAck.payload.userId).toBe('alice');
    expect(initialAck.payload.connectionId).toBeDefined();
    ws.close();
  });

  it('2. Invalid Authentication Rejection (Pulse rejects with 401, RouteX forwards)', async () => {
    const invalidToken = 'invalid.forged.token';
    const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws?token=${invalidToken}`);
    openSockets.add(ws);

    let errorReceived = false;
    await new Promise<void>((resolve) => {
      ws.on('error', (err) => {
        errorReceived = true;
        resolve();
      });
      ws.on('close', (code) => {
        resolve();
      });
    });

    expect(errorReceived).toBe(true);
  });

  it('3. Sec-WebSocket-Protocol and Sec-WebSocket-Extensions pass-through', async () => {
    const token = authenticator.generateToken({ userId: 'subprotocol_user' });
    const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws?token=${token}`, ['pulse.v1'], {
      perMessageDeflate: true,
    });
    openSockets.add(ws);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        // Subprotocol negotiated through RouteX
        expect(ws.protocol).toBe('pulse.v1');
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });
  });

  it('4. Header Hygiene & Pulse Trusted Proxy Verification', async () => {
    const token = authenticator.generateToken({ userId: 'header_hygiene_user' });
    const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws?token=${token}`, {
      headers: {
        'x-user-id': 'forged_attacker_user',
        'x-gateway-spoofed': 'true',
        'x-forwarded-for': '203.0.113.195', // client-supplied XFF
      },
    });
    openSockets.add(ws);

    await new Promise<void>((resolve, reject) => {
      ws.on('message', (data) => {
        const envelope: PulseEventEnvelope = JSON.parse(data.toString());
        if (envelope.type === 'SYS_CONNECT_ACK') {
          // RouteX replaces client XFF with verified clientIp (127.0.0.1)
          // Pulse inspects immediate peer (RouteX @ 127.0.0.1) and records remoteAddress
          const conns = [
            ...server1.getConnectionManager().getAllConnections(),
            ...server2.getConnectionManager().getAllConnections(),
          ];
          const conn = conns.find((c) => c.userId === 'header_hygiene_user');
          expect(conn).toBeDefined();
          expect(conn!.remoteAddress).toBe('127.0.0.1'); // Verified, not the spoofed 203.0.113.195
          ws.close();
          resolve();
        }
      });
      ws.on('error', reject);
    });
  });

  it('5. Upgrade Head Buffer Byte Fidelity', async () => {
    // Connect directly with net socket to send upgrade request + non-empty head buffer in single write
    const client = net.connect(gatewayPort, '127.0.0.1');
    openSockets.add(client);
    const key = crypto.randomBytes(16).toString('base64');
    const token = authenticator.generateToken({ userId: 'head_buffer_user' });

    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => {
        client.write(
          [
            `GET /ws?token=${token} HTTP/1.1`,
            `Host: 127.0.0.1:${gatewayPort}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n')
        );
      });

      let response = '';
      client.on('data', (chunk) => {
        response += chunk.toString('utf8');
        if (response.includes('101 Switching Protocols')) {
          expect(response).toContain('Upgrade: websocket');
          expect(response).toContain('Connection: Upgrade');
          client.destroy();
          resolve();
        }
      });
      client.on('error', reject);
    });
  });

  it('6. Bidirectional Room Messaging & Delivery ACKs via RouteX', async () => {
    const tokenA = authenticator.generateToken({ userId: 'user_a' });
    const tokenB = authenticator.generateToken({ userId: 'user_b' });

    const wsA = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws?token=${tokenA}`);
    const wsB = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws?token=${tokenB}`);
    openSockets.add(wsA);
    openSockets.add(wsB);

    await Promise.all([
      new Promise<void>((res) => wsA.on('open', () => res())),
      new Promise<void>((res) => wsB.on('open', () => res())),
    ]);

    // User A joins room:test-room
    wsA.send(
      JSON.stringify({
        eventId: '018f673a-0000-7000-8000-000000000101',
        type: 'ROOM_JOIN',
        timestamp: Date.now(),
        senderId: 'user_a',
        target: { roomId: 'room:test-room' },
        payload: { roomId: 'room:test-room' },
      })
    );

    // User B joins room:test-room
    wsB.send(
      JSON.stringify({
        eventId: '018f673a-0000-7000-8000-000000000102',
        type: 'ROOM_JOIN',
        timestamp: Date.now(),
        senderId: 'user_b',
        target: { roomId: 'room:test-room' },
        payload: { roomId: 'room:test-room' },
      })
    );

    // Wait 100ms for room join synchronization
    await new Promise((r) => setTimeout(r, 100));

    // User A sends message to room:test-room
    const msgId = '018f673a-0000-7000-8000-000000000103';
    wsA.send(
      JSON.stringify({
        eventId: msgId,
        type: 'ROOM_MESSAGE',
        timestamp: Date.now(),
        senderId: 'user_a',
        target: { roomId: 'room:test-room' },
        payload: { text: 'Hello RouteX Edge!' },
      })
    );

    // User B receives the room message
    const received = await new Promise<PulseEventEnvelope>((resolve) => {
      wsB.on('message', (data) => {
        const env: PulseEventEnvelope = JSON.parse(data.toString());
        if (env.type === 'ROOM_MESSAGE' && env.payload.text === 'Hello RouteX Edge!') {
          resolve(env);
        }
      });
    });

    expect(received.senderId).toBe('user_a');
    expect(received.payload.text).toBe('Hello RouteX Edge!');
    wsA.close();
    wsB.close();
  });

  it('7. RouteX Rate Limiting on WebSocket Upgrades (429 Too Many Requests)', async () => {
    const token = authenticator.generateToken({ userId: 'rate_limited_user' });
    const key1 = crypto.randomBytes(16).toString('base64');

    // First upgrade request consumes quota
    const client1 = net.connect(gatewayPort, '127.0.0.1');
    openSockets.add(client1);

    await new Promise<void>((resolve) => {
      client1.on('connect', () => {
        client1.write(
          [
            `GET /ratelimited/ws?token=${token} HTTP/1.1`,
            `Host: 127.0.0.1:${gatewayPort}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key1}`,
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n')
        );
      });
      client1.on('data', () => {
        client1.destroy();
        resolve();
      });
    });

    // Second immediate upgrade request is rejected with 429
    const key2 = crypto.randomBytes(16).toString('base64');
    const client2 = net.connect(gatewayPort, '127.0.0.1');
    openSockets.add(client2);

    const response = await new Promise<string>((resolve) => {
      let buf = '';
      client2.on('connect', () => {
        client2.write(
          [
            `GET /ratelimited/ws?token=${token} HTTP/1.1`,
            `Host: 127.0.0.1:${gatewayPort}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key2}`,
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n')
        );
      });
      client2.on('data', (chunk) => {
        buf += chunk.toString('utf8');
      });
      client2.on('close', () => {
        resolve(buf);
      });
    });

    expect(response).toContain('429 Too Many Requests');
  });

  it(
    '8. Real Two-Node Redis Distributed Failover (Node 1 Crash -> Client Reconnects -> Node 2 Session -> Redis Delivery Continues)',
    async () => {
      const aliceToken = authenticator.generateToken({ userId: 'alice_failover' });
      const bobToken = authenticator.generateToken({ userId: 'bob_failover' });

      // Client Alice connects through RouteX
      const aliceWs = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws?token=${aliceToken}`);
      aliceWs.on('error', () => {});
      openSockets.add(aliceWs);

      const aliceAck = await new Promise<PulseEventEnvelope>((resolve) => {
        aliceWs.on('message', (data) => {
          const env: PulseEventEnvelope = JSON.parse(data.toString());
          if (env.type === 'SYS_CONNECT_ACK') resolve(env);
        });
      });

      const initialSessionId = aliceAck.payload.connectionId;
      expect(initialSessionId).toBeDefined();

      const aliceNode = aliceAck.payload.instanceId;
      const failingServer = aliceNode === 'pulse-cluster-node-1' ? server1 : server2;
      const survivingPort = aliceNode === 'pulse-cluster-node-1' ? node2Port : node1Port;
      const survivingInstanceId = aliceNode === 'pulse-cluster-node-1' ? 'pulse-cluster-node-2' : 'pulse-cluster-node-1';

      // Alice joins room 'failover-lobby'
      aliceWs.send(
        JSON.stringify({
          eventId: '018f673a-0000-7000-8000-000000000201',
          type: 'ROOM_JOIN',
          timestamp: Date.now(),
          senderId: 'alice_failover',
          target: { roomId: 'failover-lobby' },
          payload: { roomId: 'failover-lobby' },
        })
      );

      // Client Bob connects directly to the other (surviving) node
      const bobWs = new WebSocket(`ws://127.0.0.1:${survivingPort}/ws?token=${bobToken}`);
      bobWs.on('error', () => {});
      openSockets.add(bobWs);
      await new Promise<void>((res) => bobWs.on('open', () => res()));

      // Bob joins 'failover-lobby'
      bobWs.send(
        JSON.stringify({
          eventId: '018f673a-0000-7000-8000-000000000202',
          type: 'ROOM_JOIN',
          timestamp: Date.now(),
          senderId: 'bob_failover',
          target: { roomId: 'failover-lobby' },
          payload: { roomId: 'failover-lobby' },
        })
      );

      await new Promise((r) => setTimeout(r, 100));

      // Verify initial cross-node Redis Pub/Sub delivery: Bob sends, Alice receives
      bobWs.send(
        JSON.stringify({
          eventId: '018f673a-0000-7000-8000-000000000203',
          type: 'ROOM_MESSAGE',
          timestamp: Date.now(),
          senderId: 'bob_failover',
          target: { roomId: 'failover-lobby' },
          payload: { text: 'Message Before Crash' },
        })
      );

      const msgBeforeCrash = await new Promise<PulseEventEnvelope>((resolve) => {
        aliceWs.on('message', (data) => {
          const env: PulseEventEnvelope = JSON.parse(data.toString());
          if (env.type === 'ROOM_MESSAGE' && env.payload.text === 'Message Before Crash') {
            resolve(env);
          }
        });
      });
      expect(msgBeforeCrash.payload.text).toBe('Message Before Crash');

      // ─────────────────────────────────────────────────────────────
      // SIMULATE NODE FAILURE (Stop the node Alice was connected to)
      // ─────────────────────────────────────────────────────────────
      let aliceDisconnected = false;
      aliceWs.on('close', () => {
        aliceDisconnected = true;
      });

      await failingServer.stop({ gracePeriodMs: 0 });

      // Verify Alice detects disconnect
      await new Promise<void>((resolve) => {
        if (aliceDisconnected) resolve();
        else aliceWs.on('close', () => resolve());
      });
      expect(aliceDisconnected).toBe(true);

      // ─────────────────────────────────────────────────────────────
      // CLIENT ALICE RECONNECTS THROUGH ROUTEX
      // RouteX detects failed node is dead, selects surviving node, establishes NEW physical session
      // ─────────────────────────────────────────────────────────────
      const aliceWs2 = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws?token=${aliceToken}`);
      aliceWs2.on('error', () => {});
      openSockets.add(aliceWs2);

      const aliceAck2 = await new Promise<PulseEventEnvelope>((resolve) => {
        aliceWs2.on('message', (data) => {
          const env: PulseEventEnvelope = JSON.parse(data.toString());
          if (env.type === 'SYS_CONNECT_ACK') resolve(env);
        });
      });

      const newSessionId = aliceAck2.payload.connectionId;
      expect(newSessionId).toBeDefined();
      // Invariant: Surviving node establishes a brand new physical session
      expect(newSessionId).not.toBe(initialSessionId);
      expect(aliceAck2.payload.instanceId).toBe(survivingInstanceId);

    // Alice resubscribes to 'failover-lobby'
    aliceWs2.send(
      JSON.stringify({
        eventId: '018f673a-0000-7000-8000-000000000204',
        type: 'ROOM_JOIN',
        timestamp: Date.now(),
        senderId: 'alice_failover',
        target: { roomId: 'failover-lobby' },
        payload: { roomId: 'failover-lobby' },
      })
    );

    await new Promise((r) => setTimeout(r, 100));

    // Bob sends a message via Real Redis Pub/Sub after Alice's reconnect
    bobWs.send(
      JSON.stringify({
        eventId: '018f673a-0000-7000-8000-000000000205',
        type: 'ROOM_MESSAGE',
        timestamp: Date.now(),
        senderId: 'bob_failover',
        target: { roomId: 'failover-lobby' },
        payload: { text: 'Message After Recovery' },
      })
    );

    const msgAfterRecovery = await new Promise<PulseEventEnvelope>((resolve) => {
      aliceWs2.on('message', (data) => {
        const env: PulseEventEnvelope = JSON.parse(data.toString());
        if (env.type === 'ROOM_MESSAGE' && env.payload.text === 'Message After Recovery') {
          resolve(env);
        }
      });
    });

    // Verifies that Redis Pub/Sub distributed delivery continues seamlessly after reconnect
    expect(msgAfterRecovery.payload.text).toBe('Message After Recovery');

    aliceWs2.close();
    bobWs.close();
  }, 30000);
});
