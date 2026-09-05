import http from 'http';
import { EventLoopMonitor } from '../../src/metrics/EventLoopMonitor.js';
import { PulseServer } from '../../src/core/PulseServer.js';
import { loadConfig } from '../../src/config/index.js';

describe('Checkpoint 07: EventLoopMonitor and Event-Loop Lag Telemetry', () => {
  describe('Unit: EventLoopMonitor', () => {
    let monitor: EventLoopMonitor;

    afterEach(() => {
      if (monitor && monitor.isActive()) {
        monitor.stop();
      }
    });

    it('starts, reports active status, collects non-negative lag metrics, and stops', async () => {
      monitor = new EventLoopMonitor();
      expect(monitor.isActive()).toBe(false);

      // Returns zero metrics before start
      const initial = monitor.getMetrics();
      expect(initial.meanSec).toBe(0);
      expect(initial.p50Sec).toBe(0);
      expect(initial.p99Sec).toBe(0);
      expect(initial.maxSec).toBe(0);

      monitor.start(20);
      expect(monitor.isActive()).toBe(true);

      // Wait a short tick for event loop activity
      await new Promise((resolve) => setTimeout(resolve, 50));

      const metrics = monitor.getMetrics();
      expect(typeof metrics.meanSec).toBe('number');
      expect(typeof metrics.p50Sec).toBe('number');
      expect(typeof metrics.p99Sec).toBe('number');
      expect(typeof metrics.maxSec).toBe('number');
      expect(metrics.meanSec).toBeGreaterThanOrEqual(0);
      expect(metrics.maxSec).toBeGreaterThanOrEqual(metrics.p50Sec);

      monitor.reset();
      expect(monitor.isActive()).toBe(true);

      monitor.stop();
      expect(monitor.isActive()).toBe(false);

      const afterStop = monitor.getMetrics();
      expect(afterStop.meanSec).toBe(0);
    });

    it('measures event loop delay when CPU work occurs', async () => {
      monitor = new EventLoopMonitor();
      monitor.start(10);

      // Perform a small synchronous block to create measurable event loop lag
      const start = Date.now();
      while (Date.now() - start < 30) {
        // busy wait ~30ms
      }

      // Allow event loop to process
      await new Promise((resolve) => setTimeout(resolve, 30));

      const metrics = monitor.getMetrics();
      expect(metrics.maxSec).toBeGreaterThan(0);
      expect(metrics.meanSec).toBeGreaterThan(0);

      monitor.stop();
    });
  });

  describe('Integration: PulseServer Event-Loop Metrics Lifecycle', () => {
    const testPort = 9284;
    let server: PulseServer;

    afterEach(async () => {
      if (server && server.isServerRunning()) {
        await server.stop();
      }
    });

    const fetchMetrics = (port: number): Promise<string> => {
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/metrics',
            method: 'GET',
            agent: false,
            headers: { Connection: 'close' }
          },
          (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(body));
          }
        );
        req.on('error', reject);
        req.end();
      });
    };

    it('registers event loop gauges and updates them during scrape', async () => {
      const config = loadConfig({
        port: testPort,
        host: '127.0.0.1',
        nodeEnv: 'test',
        instanceId: 'el-test-node',
        authSecret: 'test-auth-secret-32-chars-minimum!',
        redisEnabled: false,
        eventLoopMonitorIntervalMs: 500
      });

      server = new PulseServer(config);
      const registry = server.getMetricsRegistry();

      expect(registry.getMetric('pulse_event_loop_lag_seconds')).toBeDefined();
      expect(registry.getMetric('pulse_event_loop_lag_p50_seconds')).toBeDefined();
      expect(registry.getMetric('pulse_event_loop_lag_p99_seconds')).toBeDefined();
      expect(registry.getMetric('pulse_event_loop_lag_max_seconds')).toBeDefined();

      await server.start();
      expect(server.getEventLoopMonitor()?.isActive()).toBe(true);

      // Allow event loop monitor to gather samples
      await new Promise((resolve) => setTimeout(resolve, 60));

      const body = await fetchMetrics(testPort);
      expect(body).toContain('# HELP pulse_event_loop_lag_seconds');
      expect(body).toContain('# TYPE pulse_event_loop_lag_seconds gauge');
      expect(body).toContain('pulse_event_loop_lag_seconds');

      expect(body).toContain('# HELP pulse_event_loop_lag_p50_seconds');
      expect(body).toContain('# TYPE pulse_event_loop_lag_p50_seconds gauge');
      expect(body).toContain('pulse_event_loop_lag_p50_seconds');

      expect(body).toContain('# HELP pulse_event_loop_lag_p99_seconds');
      expect(body).toContain('# TYPE pulse_event_loop_lag_p99_seconds gauge');
      expect(body).toContain('pulse_event_loop_lag_p99_seconds');

      expect(body).toContain('# HELP pulse_event_loop_lag_max_seconds');
      expect(body).toContain('# TYPE pulse_event_loop_lag_max_seconds gauge');
      expect(body).toContain('pulse_event_loop_lag_max_seconds');

      await server.stop();
      expect(server.getEventLoopMonitor()).toBeNull();
    });
  });
});
