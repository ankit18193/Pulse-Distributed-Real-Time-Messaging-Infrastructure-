import WebSocket from 'ws';
import http from 'http';
import { PulseServer } from '../../src/core/PulseServer';
import { loadConfig } from '../../src/config';
import { PulseEventEnvelope } from '../../src/types';

describe('Phase 10 — Graceful Draining & Staged Handoff', () => {
  const testPort = 9293;
  const authSecret = 'phase10-draining-secret-32-chars-long!';
  const drainTimeoutMs = 500;

  const config = loadConfig({
    port: testPort,
    host: '127.0.0.1',
    nodeEnv: 'test',
    instanceId: 'pulse-draining-node',
    authSecret,
    drainTimeoutMs,
    redisEnabled: false
  });

  let server: PulseServer;

  beforeEach(async () => {
    server = new PulseServer(config);
    await server.start();
  });

  afterEach(async () => {
    await server.stop({ gracePeriodMs: 100 });
  });

  function httpGet(path: string): Promise<{ statusCode: number; body: any }> {
    return new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${testPort}${path}`, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode || 0, body: JSON.parse(data) });
          } catch {
            resolve({ statusCode: res.statusCode || 0, body: data });
          }
        });
      }).on('error', reject);
    });
  }

  test('executes staged draining lifecycle with SYS_SHUTDOWN frame, 503 readyz, and 1001 force-close', async () => {
    // 1. Initially /readyz is 200 READY
    const readyBefore = await httpGet('/readyz');
    expect(readyBefore.statusCode).toBe(200);
    expect(readyBefore.body.ready).toBe(true);
    expect(readyBefore.body.status).toBe('READY');

    // 2. Connect client 1 and client 2
    const token1 = server.getAuthenticator().generateToken({ userId: 'user-client-1' });
    const token2 = server.getAuthenticator().generateToken({ userId: 'user-client-2' });

    const ws1 = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${token1}`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${token2}`);

    const client1Messages: PulseEventEnvelope[] = [];
    const client2Messages: PulseEventEnvelope[] = [];

    ws1.on('message', (d) => client1Messages.push(JSON.parse(d.toString())));
    ws2.on('message', (d) => client2Messages.push(JSON.parse(d.toString())));

    await Promise.all([
      new Promise<void>((r) => ws1.on('open', () => r())),
      new Promise<void>((r) => ws2.on('open', () => r()))
    ]);

    expect(server.getActiveConnectionCount()).toBe(2);

    // 3. Initiate draining with handoff timeout
    server.drain(drainTimeoutMs);

    // 4. Verify /readyz transitions to 503 DRAINING
    const readyDuring = await httpGet('/readyz');
    expect(readyDuring.statusCode).toBe(503);
    expect(readyDuring.body.ready).toBe(false);
    expect(readyDuring.body.status).toBe('DRAINING');

    // 5. Verify all active sockets receive SYS_SHUTDOWN frame
    await new Promise((r) => setTimeout(r, 50));

    const shutdown1 = client1Messages.find((m) => m.type === 'SYS_SHUTDOWN');
    const shutdown2 = client2Messages.find((m) => m.type === 'SYS_SHUTDOWN');

    expect(shutdown1).toBeDefined();
    expect(shutdown2).toBeDefined();
    expect((shutdown1?.payload as any)?.drainTimeoutMs).toBe(drainTimeoutMs);
    expect((shutdown2?.payload as any)?.drainTimeoutMs).toBe(drainTimeoutMs);

    // 6. Verify new connection attempts during draining are rejected with HTTP 503
    const token3 = server.getAuthenticator().generateToken({ userId: 'user-client-3' });
    const ws3 = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${token3}`);

    const rejectedResponse = await new Promise<{ statusCode?: number }>((resolve) => {
      ws3.on('unexpected-response', (_req, res) => {
        resolve({ statusCode: res.statusCode });
      });
      ws3.on('open', () => resolve({ statusCode: 101 }));
    });

    expect(rejectedResponse.statusCode).toBe(503);

    const rejectedMetric = server.getMetricsRegistry().getCounter('pulse_connections_rejected_total');
    expect(rejectedMetric?.get({ reason: 'draining' })).toBe(1);

    // 7. Client 1 self-migrates / closes gracefully during the handoff window
    ws1.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(server.getActiveConnectionCount()).toBe(1);

    // 8. Client 2 stays connected past drain timeout; call stop() to simulate shutdown finalization
    const client2ClosePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      ws2.on('close', (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });

    await server.stop({ gracePeriodMs: 200 });

    const client2Close = await client2ClosePromise;
    // Unmigrated client must be force-closed with RFC 1001 (Going Away)
    expect(client2Close.code).toBe(1001);
    expect(client2Close.reason).toContain('Server shutting down');

    expect(server.getActiveConnectionCount()).toBe(0);
  });
});
