import http from 'http';
import { PulseServer } from '../../src/core/PulseServer.js';
import { PulseConfig } from '../../src/types/index.js';

describe('PulseServer Telemetry & Stats API Integration', () => {
  let server: PulseServer;
  let port: number;

  beforeEach(async () => {
    port = 30000 + Math.floor(Math.random() * 10000);
    const config: PulseConfig = {
      port,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'test-stats-instance-01',
      maxPayloadBytes: 1024 * 1024,
      connectionTimeoutMs: 5000,
      heartbeatIntervalMs: 10000,
      heartbeatTimeoutMs: 15000,
      metricsEnabled: true,
      redisEnabled: false
    };

    server = new PulseServer(config);
    await server.start();
  });

  afterEach(async () => {
    if (server && server.isServerRunning()) {
      await server.stop();
    }
  });

  function makeRequest(
    path: string,
    method: string = 'GET',
    headers: Record<string, string> = {}
  ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode || 0,
              headers: res.headers,
              body: data
            });
          });
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('should respond with 200 JSON stats on GET /api/stats', async () => {
    const res = await makeRequest('/api/stats');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['access-control-allow-origin']).toBeDefined();

    const data = JSON.parse(res.body);
    expect(data.status).toBe('OK');
    expect(data.instanceId).toBe('test-stats-instance-01');
    expect(typeof data.uptimeSeconds).toBe('number');
    expect(typeof data.timestamp).toBe('number');
    expect(data.connections).toBeDefined();
    expect(data.connections.active).toBe(0);
    expect(data.rooms).toBeDefined();
    expect(data.rooms.active).toBe(0);
    expect(data.throughput).toBeDefined();
    expect(typeof data.throughput.messagesReceived).toBe('number');
    expect(typeof data.throughput.messagesDelivered).toBe('number');
    expect(data.eventLoopLag).toBeDefined();
    expect(typeof data.eventLoopLag.p99Ms).toBe('number');
    expect(data.redis).toBeDefined();
    expect(data.redis.enabled).toBe(false);
  });

  it('should respond to OPTIONS preflight with 204 and CORS headers', async () => {
    const res = await makeRequest('/api/stats', 'OPTIONS', {
      Origin: 'http://localhost:5173',
      'Access-Control-Request-Method': 'GET'
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-methods']).toContain('GET');
    expect(res.headers['access-control-allow-headers']).toContain('Content-Type');
  });

  it('should alias GET /api/telemetry to /api/stats', async () => {
    const res = await makeRequest('/api/telemetry');
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.instanceId).toBe('test-stats-instance-01');
  });

  it('should serve dashboard index.html on GET /dashboard and GET /dashboard/', async () => {
    const resRoot = await makeRequest('/dashboard');
    expect([200, 301, 404]).toContain(resRoot.statusCode);

    const resSlash = await makeRequest('/dashboard/');
    if (resSlash.statusCode === 200) {
      expect(resSlash.headers['content-type']).toContain('text/html');
      expect(resSlash.body).toContain('Pulse Mission Control');
    } else {
      expect(resSlash.statusCode).toBe(404);
      const data = JSON.parse(resSlash.body);
      expect(data.error).toBe('Dashboard build not found');
    }
  });

  it('should block directory traversal attacks on /dashboard/ routes with 403 Forbidden', async () => {
    const res = await makeRequest('/dashboard/..%2F..%2Fpackage.json');
    expect([403, 404]).toContain(res.statusCode);
  });
});
