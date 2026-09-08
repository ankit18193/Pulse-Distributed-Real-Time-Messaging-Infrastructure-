import WebSocket from 'ws';
import http from 'http';
import { PulseServer } from '../../src/core/PulseServer';
import { loadConfig } from '../../src/config';

describe('Phase 10 — Concurrent Admission Control', () => {
  const testPort = 9291;
  const authSecret = 'phase10-admission-secret-32-chars-long!';
  const maxConnections = 5;

  const config = loadConfig({
    port: testPort,
    host: '127.0.0.1',
    nodeEnv: 'test',
    instanceId: 'pulse-concurrent-admission',
    authSecret,
    maxConnections,
    redisEnabled: false
  });

  let server: PulseServer;

  beforeEach(async () => {
    server = new PulseServer(config);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  function attemptConnect(index: number): Promise<{ success: boolean; statusCode?: number; ws?: WebSocket }> {
    return new Promise((resolve) => {
      const token = server.getAuthenticator().generateToken({ userId: `user-${index}` });
      const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${token}`);

      ws.on('open', () => {
        resolve({ success: true, ws });
      });

      ws.on('unexpected-response', (_req, res) => {
        resolve({ success: false, statusCode: res.statusCode, ws });
      });

      ws.on('error', () => {
        // Handled via unexpected-response or close
      });
    });
  }

  test('enforces maxConnections atomically under simultaneous concurrent upgrade bursts', async () => {
    const totalAttempts = 10;
    const promises: Promise<{ success: boolean; statusCode?: number; ws?: WebSocket }>[] = [];

    // Fire 10 simultaneous upgrade requests
    for (let i = 0; i < totalAttempts; i++) {
      promises.push(attemptConnect(i));
    }

    const results = await Promise.all(promises);

    const successful = results.filter((r) => r.success);
    const rejected = results.filter((r) => !r.success);

    // Exactly maxConnections (5) should succeed
    expect(successful.length).toBe(maxConnections);
    // Exactly remaining (5) should be rejected
    expect(rejected.length).toBe(totalAttempts - maxConnections);

    // All rejected connections must have received HTTP 503
    for (const r of rejected) {
      expect(r.statusCode).toBe(503);
    }

    // Server internal active connection count must be exactly maxConnections
    expect(server.getActiveConnectionCount()).toBe(maxConnections);

    // Prometheus metric pulse_connections_rejected_total{reason: "max_connections"} must be 5
    const counter = server.getMetricsRegistry().getCounter('pulse_connections_rejected_total');
    expect(counter?.get({ reason: 'max_connections' })).toBe(5);

    // Clean up 2 connected sockets
    const socketToClose1 = successful[0].ws!;
    const socketToClose2 = successful[1].ws!;

    await new Promise<void>((res) => {
      socketToClose1.on('close', () => res());
      socketToClose1.close();
    });
    await new Promise<void>((res) => {
      socketToClose2.on('close', () => res());
      socketToClose2.close();
    });

    // Wait a tick for server to process close
    await new Promise((r) => setTimeout(r, 50));
    expect(server.getActiveConnectionCount()).toBe(3);

    // Now 2 new slots should be available
    const newAttempt1 = await attemptConnect(101);
    const newAttempt2 = await attemptConnect(102);

    expect(newAttempt1.success).toBe(true);
    expect(newAttempt2.success).toBe(true);
    expect(server.getActiveConnectionCount()).toBe(5);

    // Attempting 1 more should be rejected with 503 again
    const overLimitAttempt = await attemptConnect(103);
    expect(overLimitAttempt.success).toBe(false);
    expect(overLimitAttempt.statusCode).toBe(503);

    // Clean up remaining open sockets
    const openSockets = [
      successful[2].ws!,
      successful[3].ws!,
      successful[4].ws!,
      newAttempt1.ws!,
      newAttempt2.ws!
    ];
    for (const ws of openSockets) {
      ws.close();
    }
  });
});
