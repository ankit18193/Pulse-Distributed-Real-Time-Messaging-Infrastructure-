import WebSocket from 'ws';
import { PulseServer } from '../../src/core/PulseServer';
import { loadConfig } from '../../src/config';
import { PulseEventEnvelope } from '../../src/types';

describe('Phase 1 — Single-Node Realtime Engine Acceptance Test', () => {
  const testPort = 9184;
  const config = loadConfig({
    port: testPort,
    host: '127.0.0.1',
    nodeEnv: 'test',
    instanceId: 'pulse-phase1-acceptance',
    authSecret: 'phase1-acceptance-secret-32-chars-long!',
    heartbeatIntervalMs: 200, // fast heartbeat for acceptance test
    heartbeatTimeoutMs: 100
  });

  let server: PulseServer;

  beforeEach(async () => {
    server = new PulseServer(config);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  async function connectClient(userId: string): Promise<{
    ws: WebSocket;
    messages: PulseEventEnvelope[];
    waitForMessage: (predicate: (msg: PulseEventEnvelope) => boolean, timeoutMs?: number) => Promise<PulseEventEnvelope>;
    close: () => Promise<void>;
  }> {
    const token = server.getAuthenticator().generateToken({ userId });
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${token}`);
    const messages: PulseEventEnvelope[] = [];

    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        messages.push(parsed);
      } catch {
        // ignore
      }
    });

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    const waitForMessage = (
      predicate: (msg: PulseEventEnvelope) => boolean,
      timeoutMs: number = 2000
    ): Promise<PulseEventEnvelope> => {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`Timeout waiting for message. Received: ${JSON.stringify(messages)}`));
        }, timeoutMs);

        const onMessage = (data: WebSocket.RawData) => {
          try {
            const parsed: PulseEventEnvelope = JSON.parse(data.toString());
            if (predicate(parsed)) {
              cleanup();
              resolve(parsed);
            }
          } catch {
            // ignore
          }
        };

        const cleanup = () => {
          clearTimeout(timeout);
          ws.off('message', onMessage);
        };

        ws.on('message', onMessage);
      });
    };

    // Confirm connection ack
    await waitForMessage((m) => m.type === 'SYS_CONNECT_ACK');

    const close = async () => {
      if (ws.readyState === WebSocket.OPEN) {
        const p = new Promise<void>((r) => ws.on('close', () => r()));
        ws.close();
        await p;
      }
    };

    return { ws, messages, waitForMessage, close };
  }

  it('proves the complete Phase 1 multi-client flow: Auth -> Rooms -> Broadcast -> Direct Message -> ACKs -> Heartbeat -> Graceful Shutdown', async () => {
    // 1. Authenticate and connect Client A, Client B, and Client C
    const clientA = await connectClient('alice');
    const clientB = await connectClient('bob');
    const clientC = await connectClient('charlie');

    expect(server.getActiveConnectionCount()).toBe(3);
    expect(server.getConnectionManager().getUserCount()).toBe(3);

    // 2. Client A, Client B, and Client C join 'engineering' room
    clientA.ws.send(JSON.stringify({ type: 'ROOM_JOIN', target: { roomId: 'engineering' }, correlationId: 'a-join' }));
    const aJoinAck = await clientA.waitForMessage((m) => m.correlationId === 'a-join');
    expect(aJoinAck.type).toBe('ROOM_JOIN_ACK');

    clientB.ws.send(JSON.stringify({ type: 'ROOM_JOIN', target: { roomId: 'engineering' }, correlationId: 'b-join' }));
    const bJoinAck = await clientB.waitForMessage((m) => m.correlationId === 'b-join');
    expect(bJoinAck.type).toBe('ROOM_JOIN_ACK');

    clientC.ws.send(JSON.stringify({ type: 'ROOM_JOIN', target: { roomId: 'engineering' }, correlationId: 'c-join' }));
    const cJoinAck = await clientC.waitForMessage((m) => m.correlationId === 'c-join');
    expect(cJoinAck.type).toBe('ROOM_JOIN_ACK');

    expect(server.getRoomManager().getConnectionCountInRoom('engineering')).toBe(3);

    // 3. Client A sends message to 'engineering' room
    clientA.ws.send(
      JSON.stringify({
        eventId: 'msg-pulse-001',
        type: 'ROOM_MESSAGE',
        target: { roomId: 'engineering' },
        payload: { text: 'Phase 1 realtime broadcast live!' },
        correlationId: 'broadcast-req-1'
      })
    );

    // 4. Verify Client A receives DELIVERY_ACK
    const deliveryAck = await clientA.waitForMessage((m) => m.correlationId === 'broadcast-req-1');
    expect(deliveryAck.type).toBe('DELIVERY_ACK');
    expect(deliveryAck.payload).toMatchObject({
      targetEventId: 'msg-pulse-001',
      status: 'ACCEPTED',
      recipientCount: 2 // Delivered to both Client B and Client C
    });

    // 5. Verify Client B and Client C receive the broadcast
    const bReceived = await clientB.waitForMessage((m) => m.eventId === 'msg-pulse-001');
    expect(bReceived.senderId).toBe('alice');
    expect(bReceived.target?.roomId).toBe('engineering');
    expect(bReceived.payload).toEqual({ text: 'Phase 1 realtime broadcast live!' });

    const cReceived = await clientC.waitForMessage((m) => m.eventId === 'msg-pulse-001');
    expect(cReceived.senderId).toBe('alice');
    expect(cReceived.target?.roomId).toBe('engineering');
    expect(cReceived.payload).toEqual({ text: 'Phase 1 realtime broadcast live!' });

    // Verify Client A did NOT receive an echo of its own message
    const aEcho = clientA.messages.find((m) => m.type === 'ROOM_MESSAGE');
    expect(aEcho).toBeUndefined();

    // 6. Direct Messaging: Client B sends direct message to Client C
    clientB.ws.send(
      JSON.stringify({
        eventId: 'dm-pulse-002',
        type: 'DIRECT_MESSAGE',
        target: { recipientId: 'charlie' },
        payload: { text: 'Direct message from Bob to Charlie' },
        correlationId: 'dm-b-to-c'
      })
    );

    const bDmAck = await clientB.waitForMessage((m) => m.correlationId === 'dm-b-to-c');
    expect(bDmAck.type).toBe('DELIVERY_ACK');
    expect(bDmAck.payload).toMatchObject({
      targetEventId: 'dm-pulse-002',
      status: 'ACCEPTED',
      delivered: true,
      recipientConnectionCount: 1
    });

    const cDmReceived = await clientC.waitForMessage((m) => m.eventId === 'dm-pulse-002');
    expect(cDmReceived.senderId).toBe('bob');
    expect(cDmReceived.payload).toEqual({ text: 'Direct message from Bob to Charlie' });

    // Client A did NOT receive the direct message between B and C
    const aDmReceived = clientA.messages.find((m) => m.eventId === 'dm-pulse-002');
    expect(aDmReceived).toBeUndefined();

    // 7. Liveness & Heartbeat: Client A sends SYS_PING, server responds with SYS_PONG
    clientA.ws.send(
      JSON.stringify({
        type: 'SYS_PING',
        correlationId: 'ping-a-1'
      })
    );

    const pongReceived = await clientA.waitForMessage((m) => m.correlationId === 'ping-a-1');
    expect(pongReceived.type).toBe('SYS_PONG');
    expect((pongReceived.payload as any).instanceId).toBe('pulse-phase1-acceptance');

    // 8. Dead connection detection: Client B stops responding and its socket gets reaped by heartbeat
    const clientBConn = server.getConnectionManager().getConnectionsByUserId('bob')[0];
    // Force connection to appear stale (> interval + timeout: 200 + 100 = 300ms)
    clientBConn.lastSeenAt = Date.now() - 400;

    const bClosedPromise = new Promise<{ code: number; reason: string }>((resolve) => {
      clientB.ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    server.getHeartbeatManager().checkHeartbeats();

    const bCloseResult = await bClosedPromise;
    expect(bCloseResult.code).toBe(1002);
    expect(bCloseResult.reason).toContain('Heartbeat timeout');

    // Verify Bob's room membership was cleaned up
    await new Promise((r) => setTimeout(r, 50));
    expect(server.getRoomManager().getConnectionCountInRoom('engineering')).toBe(2); // Alice & Charlie remain

    // 9. Graceful shutdown: Stop server, all clients receive SYS_SHUTDOWN and close cleanly
    const aShutdownPromise = clientA.waitForMessage((m) => m.type === 'SYS_SHUTDOWN');
    const cShutdownPromise = clientC.waitForMessage((m) => m.type === 'SYS_SHUTDOWN');

    await server.stop();

    const aShutdown = await aShutdownPromise;
    const cShutdown = await cShutdownPromise;
    expect(aShutdown.type).toBe('SYS_SHUTDOWN');
    expect(cShutdown.type).toBe('SYS_SHUTDOWN');

    expect(server.getActiveConnectionCount()).toBe(0);
    expect(server.getRoomManager().getRoomCount()).toBe(0);
  });
});
