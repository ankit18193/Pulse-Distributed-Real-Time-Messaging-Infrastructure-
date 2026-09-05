import WebSocket from 'ws';
import { PulseServer } from '../../src/core/PulseServer.js';
import { loadConfig } from '../../src/config/index.js';
import { Authenticator } from '../../src/auth/Authenticator.js';
import { PulseEventEnvelope } from '../../src/types/index.js';

describe('Chaos Drill: Graceful Draining & Zero-Downtime Handover', () => {
  const nodePort = 9281;
  const authSecret = 'pulse-draining-chaos-secret-32ch!';
  const authenticator = new Authenticator(authSecret);

  let server: PulseServer;

  beforeEach(async () => {
    const config = loadConfig({
      port: nodePort,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'pulse-draining-node',
      authSecret,
      metricsEnabled: true
    });
    server = new PulseServer(config);
    await server.start();
  });

  afterEach(async () => {
    if (server && server.isServerRunning()) {
      await server.stop({ gracePeriodMs: 100 });
    }
  });

  test('server stop -> /readyz immediately 503 DRAINING -> new WS upgrades rejected with 503 -> active connections receive SYS_SHUTDOWN & code 1001 -> clean drain', async () => {
    // 1. Verify initial health readiness
    const initialReadyRes = await fetch(`http://127.0.0.1:${nodePort}/readyz`);
    expect(initialReadyRes.status).toBe(200);
    const initialReadyData = await initialReadyRes.json();
    expect(initialReadyData.status).toBe('READY');
    expect(initialReadyData.ready).toBe(true);

    // 2. Connect active client Bob
    const bobToken = authenticator.generateToken({ userId: 'bob-active' });
    const bobWs = new WebSocket(`ws://127.0.0.1:${nodePort}/ws?token=${bobToken}`);

    const bobReceived: PulseEventEnvelope[] = [];
    let bobClosed = false;
    let bobCloseCode = 0;
    let bobCloseReason = '';

    bobWs.on('message', (d) => {
      try {
        bobReceived.push(JSON.parse(d.toString()));
      } catch {}
    });

    bobWs.on('close', (code, reason) => {
      bobClosed = true;
      bobCloseCode = code;
      bobCloseReason = reason.toString();
    });

    await new Promise<void>((resolve, reject) => {
      bobWs.once('open', () => resolve());
      bobWs.once('error', (err) => reject(err));
    });

    expect(server.getActiveConnectionCount()).toBe(1);

    // 3. Initiate graceful server draining
    server.drain();

    // 4. Invariant 1: /readyz immediately flips to HTTP 503 DRAINING
    const drainingReadyRes = await fetch(`http://127.0.0.1:${nodePort}/readyz`);
    expect(drainingReadyRes.status).toBe(503);
    const drainingReadyData = await drainingReadyRes.json();
    expect(drainingReadyData.status).toBe('DRAINING');
    expect(drainingReadyData.ready).toBe(false);
    expect(drainingReadyData.reason).toBe('Server is draining connections');

    // 5. Invariant 2: New WebSocket upgrade attempts are rejected with HTTP 503 Service Unavailable
    const aliceToken = authenticator.generateToken({ userId: 'alice-new-rejected' });
    let newConnectionRejected = false;
    let rejectionErrorMessage = '';

    await new Promise<void>((resolve) => {
      const rejectedWs = new WebSocket(`ws://127.0.0.1:${nodePort}/ws?token=${aliceToken}`);
      rejectedWs.on('open', () => {
        rejectedWs.close();
        resolve();
      });
      rejectedWs.on('error', (err) => {
        newConnectionRejected = true;
        rejectionErrorMessage = err.message;
        resolve();
      });
    });

    expect(newConnectionRejected).toBe(true);
    expect(rejectionErrorMessage).toContain('503');

    // 6. Invariant 3: Active connection Bob receives SYS_SHUTDOWN frame
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 1000;
      const interval = setInterval(() => {
        if (bobReceived.some((m) => m.type === 'SYS_SHUTDOWN') || Date.now() > deadline) {
          clearInterval(interval);
          resolve();
        }
      }, 20);
    });

    const shutdownMsg = bobReceived.find((m) => m.type === 'SYS_SHUTDOWN');
    expect(shutdownMsg).toBeDefined();
    expect(shutdownMsg?.payload?.reason).toBe('Server shutting down gracefully');

    // 7. Complete server shutdown: sockets closed with RFC 6455 code 1001 (Going Away)
    const startStopHr = process.hrtime.bigint();
    await server.stop({ gracePeriodMs: 500 });
    const elapsedMs = Number(process.hrtime.bigint() - startStopHr) / 1e6;
    expect(elapsedMs).toBeLessThanOrEqual(1000);

    // 8. Invariant 4: Active connection closes with RFC 6455 code 1001 (Going Away)
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 1000;
      const interval = setInterval(() => {
        if (bobClosed || Date.now() > deadline) {
          clearInterval(interval);
          resolve();
        }
      }, 20);
    });

    expect(bobClosed).toBe(true);
    expect(bobCloseCode).toBe(1001);
    expect(bobCloseReason).toContain('Server shutting down');

    expect(server.isServerRunning()).toBe(false);
  });
});
