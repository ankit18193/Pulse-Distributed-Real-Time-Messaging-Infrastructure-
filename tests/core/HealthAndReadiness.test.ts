import http from 'http';
import { PulseServer } from '../../src/core/PulseServer.js';
import { loadConfig } from '../../src/config/index.js';

describe('Checkpoint 08: Decoupled Liveness (/healthz) vs Readiness (/readyz)', () => {
  let server: PulseServer | null = null;

  afterEach(async () => {
    if (server && server.isServerRunning()) {
      await server.stop();
      server = null;
    }
  });

  const makeGetRequest = (
    port: number,
    path: string
  ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: any }> => {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method: 'GET',
          agent: false,
          headers: { Connection: 'close' }
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            let parsed = {};
            try {
              parsed = JSON.parse(data);
            } catch {
              parsed = data;
            }
            resolve({
              statusCode: res.statusCode || 0,
              headers: res.headers,
              body: parsed
            });
          });
        }
      );
      req.on('error', reject);
      req.end();
    });
  };

  it('handles Normal state with Redis disabled: both /healthz and /readyz return 200', async () => {
    const port = 9380;
    const config = loadConfig({
      port,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'test-node-no-redis',
      authSecret: 'test-auth-secret-32-chars-minimum!',
      redisEnabled: false
    });

    server = new PulseServer(config);
    await server.start();

    // Liveness
    const health = await makeGetRequest(port, '/healthz');
    expect(health.statusCode).toBe(200);
    expect(health.body.status).toBe('OK');
    expect(health.body.redis.enabled).toBe(false);

    // Readiness
    const ready = await makeGetRequest(port, '/readyz');
    expect(ready.statusCode).toBe(200);
    expect(ready.body.ready).toBe(true);
    expect(ready.body.status).toBe('READY');
  });

  it('handles Redis connected state: both /healthz and /readyz return 200', async () => {
    const port = 9381;
    const mockPubSub: any = {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      isConnected: jest.fn().mockReturnValue(true),
      getStatus: jest.fn().mockReturnValue({
        publisher: 'connected',
        subscriber: 'connected',
        isConnected: true
      }),
      getMetricsSnapshot: jest.fn().mockReturnValue({}),
      onMessage: jest.fn()
    };

    const config = loadConfig({
      port,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'test-node-connected',
      authSecret: 'test-auth-secret-32-chars-minimum!',
      redisEnabled: true
    });

    server = new PulseServer(config, {}, { redisPubSubManager: mockPubSub });
    await server.start();

    // Liveness
    const health = await makeGetRequest(port, '/healthz');
    expect(health.statusCode).toBe(200);
    expect(health.body.status).toBe('OK');
    expect(health.body.redis.enabled).toBe(true);
    expect(health.body.redis.isConnected).toBe(true);

    // Readiness
    const ready = await makeGetRequest(port, '/readyz');
    expect(ready.statusCode).toBe(200);
    expect(ready.body.ready).toBe(true);
    expect(ready.body.status).toBe('READY');
  });

  it('handles Redis disconnected state: /healthz returns 200 (liveness ok) but /readyz returns 503', async () => {
    const port = 9382;
    const mockPubSub: any = {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      isConnected: jest.fn().mockReturnValue(false),
      getStatus: jest.fn().mockReturnValue({
        publisher: 'disconnected',
        subscriber: 'disconnected',
        isConnected: false
      }),
      getMetricsSnapshot: jest.fn().mockReturnValue({}),
      onMessage: jest.fn()
    };

    const config = loadConfig({
      port,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'test-node-redis-down',
      authSecret: 'test-auth-secret-32-chars-minimum!',
      redisEnabled: true
    });

    server = new PulseServer(config, {}, { redisPubSubManager: mockPubSub });
    await server.start();

    // Liveness MUST NOT fail when Redis is disconnected: Pulse continues in degraded local mode
    const health = await makeGetRequest(port, '/healthz');
    expect(health.statusCode).toBe(200);
    expect(health.body.status).toBe('DEGRADED');

    // Readiness MUST return 503 so load balancer does not route new ingress traffic here
    const ready = await makeGetRequest(port, '/readyz');
    expect(ready.statusCode).toBe(503);
    expect(ready.body.ready).toBe(false);
    expect(ready.body.status).toBe('NOT_READY');
    expect(ready.body.reason).toContain('Redis is enabled but disconnected');
  });

  it('handles draining / shutdown state: both /healthz and /readyz return 503', async () => {
    const port = 9383;
    const config = loadConfig({
      port,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'test-node-draining',
      authSecret: 'test-auth-secret-32-chars-minimum!',
      redisEnabled: false
    });

    server = new PulseServer(config);
    await server.start();

    // Simulate graceful shutdown draining
    (server as any).isShuttingDown = true;

    // Liveness
    const health = await makeGetRequest(port, '/healthz');
    expect(health.statusCode).toBe(503);
    expect(health.body.status).toBe('DRAINING');

    // Readiness
    const ready = await makeGetRequest(port, '/readyz');
    expect(ready.statusCode).toBe(503);
    expect(ready.body.ready).toBe(false);
    expect(ready.body.status).toBe('DRAINING');
  });

  it('maintains compatibility with legacy /health path', async () => {
    const port = 9384;
    const config = loadConfig({
      port,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'test-node-legacy',
      authSecret: 'test-auth-secret-32-chars-minimum!',
      redisEnabled: false
    });

    server = new PulseServer(config);
    await server.start();

    const health = await makeGetRequest(port, '/health');
    expect(health.statusCode).toBe(200);
    expect(health.body.status).toBe('OK');
  });
});
