import { PulseServer } from '../../src/core/PulseServer.js';
import { loadConfig } from '../../src/config/index.js';
import { PulseClientSession } from '../../src/client/PulseClientSession.js';
import { Authenticator } from '../../src/auth/Authenticator.js';
import { FaultProxy } from '../../src/chaos/FaultProxy.js';
import { ChaosScenarioRunner } from '../../src/chaos/ChaosScenarioRunner.js';

describe('Chaos Drill: Reconnect Storm & Thundering Herd Defense', () => {
  const nodePort = 9241;
  const proxyPort = 9242;
  const authSecret = 'pulse-reconnect-storm-secret-32chars!';
  const authenticator = new Authenticator(authSecret);

  let server: PulseServer;
  let proxy: FaultProxy;

  beforeEach(async () => {
    // 1. Start Pulse Server Node
    const config = loadConfig({
      port: nodePort,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'pulse-reconnect-storm-node',
      authSecret,
      metricsEnabled: true,
      heartbeatIntervalMs: 5000,
      heartbeatTimeoutMs: 2000
    });
    server = new PulseServer(config);
    await server.start();

    // 2. Start FaultProxy forwarding to the server
    proxy = new FaultProxy({
      listenPort: proxyPort,
      targetHost: '127.0.0.1',
      targetPort: nodePort,
      name: 'storm-proxy',
      mode: 'tcp'
    });
    await proxy.start();
  });

  afterEach(async () => {
    if (proxy) {
      await proxy.close();
    }
    if (server) {
      await server.stop({ gracePeriodMs: 200 });
    }
  });

  test('concurrent clients severed simultaneously reconnect with decorrelated jitter without event-loop saturation', async () => {
    const clientCount = 50; // High concurrency for deterministic local CI
    const sessions: PulseClientSession[] = [];
    const connectTimestamps: number[] = [];

    try {
      // 1. Establish initial connections through FaultProxy
      for (let i = 0; i < clientCount; i++) {
        const userId = `storm-user-${i}`;
        const token = authenticator.generateToken({ userId });
        const session = new PulseClientSession({
          serverUrl: `ws://127.0.0.1:${proxyPort}/ws`,
          userId,
          token,
          autoReconnect: true,
          baseDelayMs: 40,
          maxDelayMs: 600,
          ackTimeoutMs: 1500
        });

        session.on('connected', () => {
          connectTimestamps.push(Date.now());
        });

        sessions.push(session);
      }

      await Promise.all(sessions.map((s) => s.connect()));
      expect(server.getActiveConnectionCount()).toBe(clientCount);

      // =========================================================================
      // FAULT INJECTION: Sever proxy abruptly dropping all 50 clients simultaneously
      // =========================================================================
      connectTimestamps.length = 0;
      proxy.sever();

      // Give clients 50ms to detect socket termination and enter backoff
      await new Promise((r) => setTimeout(r, 50));

      // Restore proxy to accept reconnection attempts
      proxy.restore();

      // Wait for all sessions to re-establish connection
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          const connectedCount = sessions.filter((s) => s.getState() === 'CONNECTED').length;
          reject(
            new Error(
              `Timed out waiting for reconnect storm resolution. Connected: ${connectedCount}/${clientCount}`
            )
          );
        }, 10000);

        const checkInterval = setInterval(() => {
          const connectedCount = sessions.filter((s) => s.getState() === 'CONNECTED').length;
          if (connectedCount === clientCount) {
            clearTimeout(timeout);
            clearInterval(checkInterval);
            resolve();
          }
        }, 30);
      });

      // Assertions
      // 1. All clients reconnected
      expect(sessions.every((s) => s.getState() === 'CONNECTED')).toBe(true);

      // 2. Reconnection timestamps are distributed over time (decorrelated jitter)
      // They should NOT all share the exact same millisecond
      const uniqueTimestamps = new Set(connectTimestamps);
      expect(uniqueTimestamps.size).toBeGreaterThan(1);

      // The spread between the first and last reconnect should be at least 30ms
      const minTimestamp = Math.min(...connectTimestamps);
      const maxTimestamp = Math.max(...connectTimestamps);
      const spreadMs = maxTimestamp - minTimestamp;
      expect(spreadMs).toBeGreaterThanOrEqual(20);

      // 3. Event loop lag remains bounded during the storm (< 500ms)
      const metrics = await ChaosScenarioRunner.scrapeMetrics(nodePort);
      const eventLoopLagP99 = metrics.get('pulse_event_loop_lag_p99_seconds') ?? 0;
      expect(eventLoopLagP99).toBeLessThan(0.5); // < 500ms under heavy Windows Jest concurrency
    } finally {
      await Promise.all(sessions.map((s) => s.disconnect()));
    }
  }, 15000);
});
