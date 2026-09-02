import { WebSocket } from 'ws';
import { PulseServer } from '../../src/core/PulseServer';
import { loadConfig } from '../../src/config';

describe('Native RFC 6455 Ping/Pong Transport Keepalive (Phase 2)', () => {
  let server: PulseServer;
  const testPort = 9188;
  const authSecret = 'native-ping-pong-secret-min-32-chars-required';

  beforeAll(async () => {
    const config = loadConfig({
      port: testPort,
      instanceId: 'test-native-ping-node',
      authSecret
    });
    server = new PulseServer(config);
    await server.start();
  });

  afterAll(async () => {
    await server.stop({ gracePeriodMs: 50 });
  });

  it('updates connection.lastSeenAt when client sends native RFC 6455 ping', async () => {
    const token = server.getAuthenticator().generateToken({ userId: 'native_pinger' });
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${token}`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', (err) => reject(err));
    });

    // Wait for SYS_CONNECT_ACK
    await new Promise((r) => setTimeout(r, 50));

    const connections = server.getConnectionManager().getConnectionsByUserId('native_pinger');
    expect(connections).toHaveLength(1);
    const conn = connections[0];

    const initialLastSeen = conn.lastSeenAt;

    // Advance time slightly
    await new Promise((r) => setTimeout(r, 60));

    // Send native protocol ping (opcode 0x9)
    const pongPromise = new Promise<void>((resolve) => {
      ws.once('pong', () => resolve());
    });
    ws.ping();
    await pongPromise;

    // Verify connection.touch() was invoked
    expect(conn.lastSeenAt).toBeGreaterThan(initialLastSeen);

    ws.close();
  });

  it('updates connection.lastSeenAt when client responds with native RFC 6455 pong', async () => {
    const token = server.getAuthenticator().generateToken({ userId: 'native_ponger' });
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${token}`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', (err) => reject(err));
    });

    await new Promise((r) => setTimeout(r, 50));

    const connections = server.getConnectionManager().getConnectionsByUserId('native_ponger');
    expect(connections).toHaveLength(1);
    const conn = connections[0];

    const initialLastSeen = conn.lastSeenAt;
    await new Promise((r) => setTimeout(r, 60));

    // Client sends native pong unsolicited
    ws.pong();
    await new Promise((r) => setTimeout(r, 30));

    expect(conn.lastSeenAt).toBeGreaterThan(initialLastSeen);

    ws.close();
  });
});
