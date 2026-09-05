import http from 'http';
import { PulseServer } from '../../src/core/PulseServer.js';
import { loadConfig } from '../../src/config/index.js';
import { Counter } from '../../src/metrics/Counter.js';
import { Gauge } from '../../src/metrics/Gauge.js';

describe('Checkpoint 06: GET /metrics Endpoint', () => {
  const testPort = 9280;
  let server: PulseServer;

  afterEach(async () => {
    if (server && server.isServerRunning()) {
      await server.stop();
    }
  });

  const makeRequest = (
    path: string,
    port: number = testPort,
    method: string = 'GET'
  ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> => {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          agent: false,
          headers: {
            Connection: 'close'
          }
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode || 0,
              headers: res.headers,
              body
            });
          });
        }
      );
      req.on('error', reject);
      req.end();
    });
  };

  it('exposes GET /metrics with HTTP 200 and Prometheus content type', async () => {
    const config = loadConfig({
      port: testPort,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'test-metrics-node',
      authSecret: 'test-auth-secret-32-chars-minimum!',
      redisEnabled: false
    });

    server = new PulseServer(config);
    const registry = server.getMetricsRegistry();

    const counter = new Counter({
      name: 'pulse_test_events_total',
      help: 'Test event counter'
    });
    counter.inc(undefined, 7);
    registry.register(counter);

    const gauge = new Gauge({
      name: 'pulse_test_active_gauge',
      help: 'Test active gauge'
    });
    gauge.set(42);
    registry.register(gauge);

    await server.start();

    const response = await makeRequest('/metrics');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');

    expect(response.body).toContain('# HELP pulse_test_events_total Test event counter');
    expect(response.body).toContain('# TYPE pulse_test_events_total counter');
    expect(response.body).toContain('pulse_test_events_total 7');

    expect(response.body).toContain('# HELP pulse_test_active_gauge Test active gauge');
    expect(response.body).toContain('# TYPE pulse_test_active_gauge gauge');
    expect(response.body).toContain('pulse_test_active_gauge 42');
  });

  it('supports custom metrics path when configured', async () => {
    const customPort = 9281;
    const config = loadConfig({
      port: customPort,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'custom-path-node',
      authSecret: 'test-auth-secret-32-chars-minimum!',
      redisEnabled: false,
      metricsPath: '/custom/prometheus'
    });

    server = new PulseServer(config);
    await server.start();

    const res = await makeRequest('/custom/prometheus', customPort);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
  });

  it('returns 404 when metrics are explicitly disabled', async () => {
    const disabledPort = 9282;
    const config = loadConfig({
      port: disabledPort,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'disabled-node',
      authSecret: 'test-auth-secret-32-chars-minimum!',
      redisEnabled: false,
      metricsEnabled: false
    });

    server = new PulseServer(config);
    await server.start();

    const res = await makeRequest('/metrics', disabledPort);
    expect(res.statusCode).toBe(404);
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toContain('disabled');
  });

  it('returns 404 for unknown routes and non-GET methods', async () => {
    const config = loadConfig({
      port: testPort,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'test-routes-node',
      authSecret: 'test-auth-secret-32-chars-minimum!',
      redisEnabled: false
    });

    server = new PulseServer(config);
    await server.start();

    const unknownRes = await makeRequest('/unknown-path');
    expect(unknownRes.statusCode).toBe(404);

    const postRes = await makeRequest('/metrics', testPort, 'POST');
    expect(postRes.statusCode).toBe(404);
  });

  it('handles repeated rapid scrapes deterministically without errors', async () => {
    const scrapePort = 9283;
    const config = loadConfig({
      port: scrapePort,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'test-scrapes-node',
      authSecret: 'test-auth-secret-32-chars-minimum!',
      redisEnabled: false
    });

    server = new PulseServer(config);
    const counter = new Counter({ name: 'pulse_scrape_counter', help: 'scrape' });
    server.getMetricsRegistry().register(counter);
    counter.inc();

    await server.start();

    // 10 concurrent scrapes
    const requests = Array.from({ length: 10 }).map(() => makeRequest('/metrics', scrapePort));
    const results = await Promise.all(requests);

    for (const r of results) {
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('pulse_scrape_counter 1');
    }
  });
});
