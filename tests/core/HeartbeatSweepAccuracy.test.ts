import { WebSocket } from 'ws';
import { PulseServer } from '../../src/core/PulseServer';
import { loadConfig } from '../../src/config';

describe('Heartbeat Sweep Accuracy (Phase 2)', () => {
  let server: PulseServer;
  const testPort = 9189;
  const authSecret = 'heartbeat-accuracy-secret-min-32-chars-needed';

  beforeAll(async () => {
    const config = loadConfig({
      port: testPort,
      instanceId: 'test-heartbeat-acc-node',
      authSecret,
      heartbeatIntervalMs: 80,
      heartbeatTimeoutMs: 40 // total threshold = 120ms; sweep tick = 20ms
    });
    server = new PulseServer(config);
    await server.start();
  });

  afterAll(async () => {
    await server.stop({ gracePeriodMs: 50 });
  });

  it('automatically reaps dead connections via sub-tick sweep timer promptly', async () => {
    const token = server.getAuthenticator().generateToken({ userId: 'stale_subject' });
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${token}`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', (err) => reject(err));
    });

    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on('close', (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });

    const startTime = Date.now();
    const result = await closePromise;
    const elapsed = Date.now() - startTime;

    expect(result.code).toBe(1002);
    expect(result.reason).toContain('Heartbeat timeout');

    // Threshold is 120ms; sweep tick is 20ms. Should be reaped around ~120ms-180ms
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(350);

    // Verify connection was removed from server
    expect(server.getActiveConnectionCount()).toBe(0);
  });
});
