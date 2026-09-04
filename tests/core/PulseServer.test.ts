import WebSocket from 'ws';
import http from 'http';
import { PulseServer } from '../../src/core/PulseServer';
import { loadConfig } from '../../src/config';

describe('PulseServer Core Lifecycle (Commit 1 & 2)', () => {
  const testPort = 9181;
  const config = loadConfig({
    port: testPort,
    host: '127.0.0.1',
    nodeEnv: 'test',
    instanceId: 'test-node-1',
    authSecret: 'pulse-test-secret-32-chars-long!'
  });

  let server: PulseServer;
  let testToken: string;

  beforeEach(async () => {
    server = new PulseServer(config);
    testToken = server.getAuthenticator().generateToken({ userId: 'test_user' });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('starts and exposes health endpoint', async () => {
    const res = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      http.get(`http://127.0.0.1:${testPort}/healthz`, (response) => {
        let data = '';
        response.on('data', (chunk) => (data += chunk));
        response.on('end', () =>
          resolve({ statusCode: response.statusCode || 0, body: data })
        );
      }).on('error', reject);
    });

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.status).toBe('OK');
    expect(parsed.instanceId).toBe('test-node-1');
    expect(parsed.connections).toBe(0);
  });

  it('accepts incoming authenticated WebSocket connection and tracks active connection count', async () => {
    expect(server.getActiveConnectionCount()).toBe(0);

    const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${testToken}`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    expect(server.getActiveConnectionCount()).toBe(1);

    // Close socket
    ws.close();
    await new Promise<void>((resolve) => {
      ws.on('close', () => resolve());
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(server.getActiveConnectionCount()).toBe(0);
  });

  it('shuts down cleanly and terminates remaining active sockets', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${testToken}`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    expect(server.getActiveConnectionCount()).toBe(1);

    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    await server.stop();

    const closeResult = await closePromise;
    expect(closeResult.code).toBe(1001); // 1001 Going Away
    expect(server.getActiveConnectionCount()).toBe(0);
  });

  describe('Health Endpoint States (/healthz)', () => {
    it('reports status: DEGRADED when Redis is enabled but disconnected', async () => {
      const degradedPort = 9183;
      const mockPubSub: any = {
        connect: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        isConnected: jest.fn().mockReturnValue(false),
        getStatus: jest.fn().mockReturnValue({ publisher: 'disconnected', subscriber: 'disconnected', isConnected: false }),
        getMetricsSnapshot: jest.fn().mockReturnValue({}),
        onMessage: jest.fn()
      };

      const degradedConfig = loadConfig({
        port: degradedPort,
        host: '127.0.0.1',
        nodeEnv: 'test',
        instanceId: 'test-degraded-node',
        authSecret: 'pulse-test-secret-32-chars-long!',
        redisEnabled: true
      });

      const degradedServer = new PulseServer(degradedConfig, {}, { redisPubSubManager: mockPubSub });
      await degradedServer.start();

      try {
        const res = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
          http.get(`http://127.0.0.1:${degradedPort}/healthz`, (response) => {
            let data = '';
            response.on('data', (chunk) => (data += chunk));
            response.on('end', () =>
              resolve({ statusCode: response.statusCode || 0, body: data })
            );
          }).on('error', reject);
        });

        expect(res.statusCode).toBe(200);
        const parsed = JSON.parse(res.body);
        expect(parsed.status).toBe('DEGRADED');
        expect(parsed.redis.enabled).toBe(true);
        expect(parsed.redis.isConnected).toBe(false);
      } finally {
        await degradedServer.stop();
      }
    });

    it('reports status: OK when Redis is enabled and connected', async () => {
      const connectedPort = 9184;
      const mockPubSub: any = {
        connect: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        isConnected: jest.fn().mockReturnValue(true),
        getStatus: jest.fn().mockReturnValue({ publisher: 'connected', subscriber: 'connected', isConnected: true }),
        getMetricsSnapshot: jest.fn().mockReturnValue({}),
        onMessage: jest.fn()
      };

      const connectedConfig = loadConfig({
        port: connectedPort,
        host: '127.0.0.1',
        nodeEnv: 'test',
        instanceId: 'test-connected-node',
        authSecret: 'pulse-test-secret-32-chars-long!',
        redisEnabled: true
      });

      const connectedServer = new PulseServer(connectedConfig, {}, { redisPubSubManager: mockPubSub });
      await connectedServer.start();

      try {
        const res = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
          http.get(`http://127.0.0.1:${connectedPort}/healthz`, (response) => {
            let data = '';
            response.on('data', (chunk) => (data += chunk));
            response.on('end', () =>
              resolve({ statusCode: response.statusCode || 0, body: data })
            );
          }).on('error', reject);
        });

        expect(res.statusCode).toBe(200);
        const parsed = JSON.parse(res.body);
        expect(parsed.status).toBe('OK');
        expect(parsed.redis.enabled).toBe(true);
        expect(parsed.redis.isConnected).toBe(true);
      } finally {
        await connectedServer.stop();
      }
    });

    it('reports status: DRAINING and HTTP 503 during shutdown', async () => {
      const drainingPort = 9185;
      const drainingConfig = loadConfig({
        port: drainingPort,
        host: '127.0.0.1',
        nodeEnv: 'test',
        instanceId: 'test-draining-node',
        authSecret: 'pulse-test-secret-32-chars-long!'
      });

      const drainingServer = new PulseServer(drainingConfig);
      await drainingServer.start();

      // Simulate draining state
      (drainingServer as any).isShuttingDown = true;

      try {
        const res = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
          http.get(`http://127.0.0.1:${drainingPort}/healthz`, (response) => {
            let data = '';
            response.on('data', (chunk) => (data += chunk));
            response.on('end', () =>
              resolve({ statusCode: response.statusCode || 0, body: data })
            );
          }).on('error', reject);
        });

        expect(res.statusCode).toBe(503);
        const parsed = JSON.parse(res.body);
        expect(parsed.status).toBe('DRAINING');
      } finally {
        (drainingServer as any).isShuttingDown = false;
        await drainingServer.stop();
      }
    });
  });
});
