import WebSocket from 'ws';
import http from 'http';
import { PulseServer } from '../../src/core/PulseServer';
import { loadConfig } from '../../src/config';

describe('PulseServer Core Lifecycle (Commit 1 & 2)', () => {
  const testPort = 9181;
  const config = loadConfig({
    port: testPort,
    host: '127.0.0.1',
    nodeEnv: 'test',
    instanceId: 'test-node-1',
    authSecret: 'pulse-test-secret-32-chars-long!'
  });

  let server: PulseServer;
  let testToken: string;

  beforeEach(async () => {
    server = new PulseServer(config);
    testToken = server.getAuthenticator().generateToken({ userId: 'test_user' });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('starts and exposes health endpoint', async () => {
    const res = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      http.get(`http://127.0.0.1:${testPort}/healthz`, (response) => {
        let data = '';
        response.on('data', (chunk) => (data += chunk));
        response.on('end', () =>
          resolve({ statusCode: response.statusCode || 0, body: data })
        );
      }).on('error', reject);
    });

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.status).toBe('OK');
    expect(parsed.instanceId).toBe('test-node-1');
    expect(parsed.connections).toBe(0);
  });

  it('accepts incoming authenticated WebSocket connection and tracks active connection count', async () => {
    expect(server.getActiveConnectionCount()).toBe(0);

    const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${testToken}`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    expect(server.getActiveConnectionCount()).toBe(1);

    // Close socket
    ws.close();
    await new Promise<void>((resolve) => {
      ws.on('close', () => resolve());
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(server.getActiveConnectionCount()).toBe(0);
  });

  it('shuts down cleanly and terminates remaining active sockets', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${testToken}`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    expect(server.getActiveConnectionCount()).toBe(1);

    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    await server.stop();

    const closeResult = await closePromise;
    expect(closeResult.code).toBe(1001); // 1001 Going Away
    expect(server.getActiveConnectionCount()).toBe(0);
  });
});
