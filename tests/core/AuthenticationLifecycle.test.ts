import WebSocket from 'ws';
import { PulseServer } from '../../src/core/PulseServer';
import { loadConfig } from '../../src/config';
import { PulseEventEnvelope } from '../../src/types';

describe('Authentication & Connection Lifecycle (Commit 2)', () => {
  const testPort = 9182;
  const config = loadConfig({
    port: testPort,
    host: '127.0.0.1',
    nodeEnv: 'test',
    instanceId: 'test-node-auth',
    authSecret: 'pulse-auth-test-secret-key-32chars'
  });

  let server: PulseServer;

  beforeEach(async () => {
    server = new PulseServer(config);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('accepts connection with valid token and delivers SYS_CONNECT_ACK', async () => {
    const validToken = server.getAuthenticator().generateToken({
      userId: 'alice',
      roles: ['engineer']
    });

    const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${validToken}`);

    const connectAckPromise = new Promise<PulseEventEnvelope>((resolve, reject) => {
      ws.on('message', (data) => {
        try {
          const envelope = JSON.parse(data.toString());
          if (envelope.type === 'SYS_CONNECT_ACK') {
            resolve(envelope);
          }
        } catch (e) {
          reject(e);
        }
      });
      ws.on('error', reject);
    });

    const ack = await connectAckPromise;
    expect(ack.type).toBe('SYS_CONNECT_ACK');
    expect(ack.payload).toMatchObject({
      userId: 'alice',
      instanceId: 'test-node-auth'
    });
    expect(typeof (ack.payload as any).connectionId).toBe('string');

    // Verify tracked in ConnectionManager
    expect(server.getActiveConnectionCount()).toBe(1);
    const aliceConns = server.getConnectionManager().getConnectionsByUserId('alice');
    expect(aliceConns.length).toBe(1);
    expect(aliceConns[0].userId).toBe('alice');
    expect(aliceConns[0].roles).toContain('engineer');

    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(server.getActiveConnectionCount()).toBe(0);
  });

  it('rejects connection without token with HTTP 401', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws`);

    const errorPromise = new Promise<Error>((resolve) => {
      ws.on('error', (err) => resolve(err));
    });

    const err = await errorPromise;
    expect(err.message).toMatch(/401/);
    expect(server.getActiveConnectionCount()).toBe(0);
  });

  it('rejects connection with invalid/tampered token with HTTP 401', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=invalid.tampered.token`);

    const errorPromise = new Promise<Error>((resolve) => {
      ws.on('error', (err) => resolve(err));
    });

    const err = await errorPromise;
    expect(err.message).toMatch(/401/);
    expect(server.getActiveConnectionCount()).toBe(0);
  });

  it('tracks multiple concurrent connections for the same authenticated user', async () => {
    const token = server.getAuthenticator().generateToken({ userId: 'bob' });

    const ws1 = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${token}`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${token}`);

    await Promise.all([
      new Promise<void>((r) => ws1.on('open', () => r())),
      new Promise<void>((r) => ws2.on('open', () => r()))
    ]);

    // Short tick to allow ack dispatch
    await new Promise((r) => setTimeout(r, 50));

    expect(server.getActiveConnectionCount()).toBe(2);
    expect(server.getConnectionManager().getUserCount()).toBe(1);
    const bobConns = server.getConnectionManager().getConnectionsByUserId('bob');
    expect(bobConns.length).toBe(2);

    ws1.close();
    await new Promise((r) => setTimeout(r, 50));

    expect(server.getActiveConnectionCount()).toBe(1);
    expect(server.getConnectionManager().getUserCount()).toBe(1);

    ws2.close();
    await new Promise((r) => setTimeout(r, 50));

    expect(server.getActiveConnectionCount()).toBe(0);
    expect(server.getConnectionManager().getUserCount()).toBe(0);
  });
});
