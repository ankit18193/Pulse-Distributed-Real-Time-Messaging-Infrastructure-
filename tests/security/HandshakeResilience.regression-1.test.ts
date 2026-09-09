// Regression: ISSUE-001 — Unhandled TCP socket error during rejected HTTP upgrade causes process crash
// Found by /qa on 2026-09-09
// Report: .gstack/qa-reports/qa-report-localhost-2026-09-09.md

import net from 'net';
import WebSocket from 'ws';
import { PulseServer } from '../../src/core/PulseServer.js';
import { Authenticator } from '../../src/auth/Authenticator.js';

describe('Handshake Resilience Regression Suite (ISSUE-001)', () => {
  const TEST_PORT = 9393;
  const TEST_SECRET = 'handshake-resilience-secret-32-chars!';
  let server: PulseServer;

  beforeEach(async () => {
    server = new PulseServer({
      port: TEST_PORT,
      authSecret: TEST_SECRET,
      redisEnabled: false
    });
    await server.start();
  });

  afterEach(async () => {
    if (server && server.isServerRunning()) {
      await server.stop();
    }
  });

  test('absorbs immediate client TCP reset (ECONNRESET) on rejected HTTP upgrade without crashing process', async () => {
    const uncaughtSpy = jest.fn();
    process.on('uncaughtException', uncaughtSpy);

    // 1. Connect raw TCP socket and send unauthenticated HTTP Upgrade request
    await new Promise<void>((resolve, reject) => {
      const client = net.connect({ port: TEST_PORT, host: '127.0.0.1' }, () => {
        client.write(
          'GET / HTTP/1.1\r\n' +
          'Host: 127.0.0.1\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Sec-WebSocket-Version: 13\r\n\r\n'
        );

        // Immediately simulate a hard connection reset (RST packet)
        setTimeout(() => {
          client.destroy(new Error('read ECONNRESET'));
          resolve();
        }, 10);
      });

      client.on('error', () => {
        // expected on client side
      });
    });

    // Wait a brief window to ensure no asynchronous uncaughtException triggers
    await new Promise((r) => setTimeout(r, 100));

    expect(uncaughtSpy).not.toHaveBeenCalled();
    expect(server.isServerRunning()).toBe(true);

    process.removeListener('uncaughtException', uncaughtSpy);

    // 2. Verify server remains fully healthy and accepts valid connections
    const authenticator = new Authenticator(TEST_SECRET);
    const validToken = authenticator.generateToken({ userId: 'healthy-user' });

    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}?token=${validToken}`);
    const opened = await new Promise<boolean>((resolve) => {
      ws.on('open', () => resolve(true));
      ws.on('error', () => resolve(false));
    });

    expect(opened).toBe(true);
    ws.close();
  });
});
