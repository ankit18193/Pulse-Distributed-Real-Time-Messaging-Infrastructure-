import WebSocket from 'ws';
import { PulseServer } from '../../src/core/PulseServer';
import { loadConfig } from '../../src/config';
import { PulseEventEnvelope } from '../../src/types';

describe('Rooms, Messaging & Acknowledgements (Commit 3)', () => {
  const testPort = 9183;
  const config = loadConfig({
    port: testPort,
    host: '127.0.0.1',
    nodeEnv: 'test',
    instanceId: 'test-node-rooms',
    authSecret: 'rooms-messaging-test-secret-key-32c'
  });

  let server: PulseServer;

  beforeEach(async () => {
    server = new PulseServer(config);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  // Helper to create and connect authenticated client
  async function createClient(userId: string): Promise<{
    ws: WebSocket;
    messages: PulseEventEnvelope[];
    waitForMessage: (predicate: (msg: PulseEventEnvelope) => boolean) => Promise<PulseEventEnvelope>;
  }> {
    const token = server.getAuthenticator().generateToken({ userId });
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${token}`);
    const messages: PulseEventEnvelope[] = [];

    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        messages.push(parsed);
      } catch {
        // ignore raw
      }
    });

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    const waitForMessage = (
      predicate: (msg: PulseEventEnvelope) => boolean,
      timeoutMs: number = 1000
    ): Promise<PulseEventEnvelope> => {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`Timeout waiting for message matching predicate. Received: ${JSON.stringify(messages)}`));
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

    // Wait for SYS_CONNECT_ACK
    await waitForMessage((m) => m.type === 'SYS_CONNECT_ACK');

    return { ws, messages, waitForMessage };
  }

  it('allows clients to join a room and receive ROOM_JOIN_ACK', async () => {
    const client = await createClient('alice');

    client.ws.send(
      JSON.stringify({
        type: 'ROOM_JOIN',
        target: { roomId: 'engineering' },
        correlationId: 'join-req-1'
      })
    );

    const ack = await client.waitForMessage((m) => m.type === 'ROOM_JOIN_ACK');
    expect(ack.target?.roomId).toBe('engineering');
    expect(ack.correlationId).toBe('join-req-1');
    expect(ack.payload).toMatchObject({
      roomId: 'engineering',
      status: 'JOINED',
      memberCount: 1
    });

    expect(server.getRoomManager().getConnectionCountInRoom('engineering')).toBe(1);

    client.ws.close();
  });

  it('broadcasts room message to other room members and sends DELIVERY_ACK to sender', async () => {
    const alice = await createClient('alice');
    const bob = await createClient('bob');
    const charlie = await createClient('charlie'); // not in room

    // Alice and Bob join 'engineering'
    alice.ws.send(JSON.stringify({ type: 'ROOM_JOIN', target: { roomId: 'engineering' } }));
    await alice.waitForMessage((m) => m.type === 'ROOM_JOIN_ACK');

    bob.ws.send(JSON.stringify({ type: 'ROOM_JOIN', target: { roomId: 'engineering' } }));
    await bob.waitForMessage((m) => m.type === 'ROOM_JOIN_ACK');

    // Alice sends a message to 'engineering'
    alice.ws.send(
      JSON.stringify({
        eventId: 'msg-evt-001',
        type: 'ROOM_MESSAGE',
        target: { roomId: 'engineering' },
        payload: { text: 'Hello team!' },
        correlationId: 'corr-001'
      })
    );

    // Alice should receive DELIVERY_ACK
    const aliceAck = await alice.waitForMessage((m) => m.type === 'DELIVERY_ACK');
    expect(aliceAck.correlationId).toBe('corr-001');
    expect(aliceAck.payload).toMatchObject({
      targetEventId: 'msg-evt-001',
      status: 'ACCEPTED',
      recipientCount: 1 // Bob received it
    });

    // Bob should receive ROOM_MESSAGE
    const bobMsg = await bob.waitForMessage((m) => m.type === 'ROOM_MESSAGE');
    expect(bobMsg.eventId).toBe('msg-evt-001');
    expect(bobMsg.senderId).toBe('alice');
    expect(bobMsg.target?.roomId).toBe('engineering');
    expect(bobMsg.payload).toEqual({ text: 'Hello team!' });

    // Alice should NOT have received an echo ROOM_MESSAGE
    const aliceEcho = alice.messages.find((m) => m.type === 'ROOM_MESSAGE');
    expect(aliceEcho).toBeUndefined();

    // Charlie (outside room) should NOT receive the message
    const charlieMsg = charlie.messages.find((m) => m.type === 'ROOM_MESSAGE');
    expect(charlieMsg).toBeUndefined();

    alice.ws.close();
    bob.ws.close();
    charlie.ws.close();
  });

  it('rejects ROOM_MESSAGE from a client that has not joined the room with SYS_ERROR', async () => {
    const charlie = await createClient('charlie');

    charlie.ws.send(
      JSON.stringify({
        eventId: 'rogue-msg',
        type: 'ROOM_MESSAGE',
        target: { roomId: 'secret-ops' },
        payload: { text: 'Attempted eavesdrop injection' }
      })
    );

    const err = await charlie.waitForMessage((m) => m.type === 'SYS_ERROR');
    expect((err.payload as any).code).toBe('UNAUTHORIZED_ROOM_ACCESS');
    expect(err.correlationId).toBe('rogue-msg');

    charlie.ws.close();
  });

  it('delivers DIRECT_MESSAGE to target user across their active connections', async () => {
    const alice = await createClient('alice');
    const bobDevice1 = await createClient('bob');
    const bobDevice2 = await createClient('bob'); // Bob on a second device

    // Alice sends direct message to Bob
    alice.ws.send(
      JSON.stringify({
        eventId: 'dm-001',
        type: 'DIRECT_MESSAGE',
        target: { recipientId: 'bob' },
        payload: { note: 'Hi Bob, private note' },
        correlationId: 'dm-req-1'
      })
    );

    // Both of Bob's devices should receive the direct message
    const bob1Msg = await bobDevice1.waitForMessage((m) => m.type === 'DIRECT_MESSAGE');
    const bob2Msg = await bobDevice2.waitForMessage((m) => m.type === 'DIRECT_MESSAGE');

    expect(bob1Msg.senderId).toBe('alice');
    expect(bob1Msg.payload).toEqual({ note: 'Hi Bob, private note' });
    expect(bob2Msg.senderId).toBe('alice');
    expect(bob2Msg.payload).toEqual({ note: 'Hi Bob, private note' });

    // Alice receives DELIVERY_ACK confirming 2 recipients
    const ack = await alice.waitForMessage((m) => m.type === 'DELIVERY_ACK');
    expect(ack.payload).toMatchObject({
      targetEventId: 'dm-001',
      status: 'ACCEPTED',
      delivered: true,
      recipientConnectionCount: 2
    });

    alice.ws.close();
    bobDevice1.ws.close();
    bobDevice2.ws.close();
  });

  it('allows leaving a room and stops receiving subsequent messages', async () => {
    const alice = await createClient('alice');
    const bob = await createClient('bob');

    // Both join
    alice.ws.send(JSON.stringify({ type: 'ROOM_JOIN', target: { roomId: 'general' } }));
    await alice.waitForMessage((m) => m.type === 'ROOM_JOIN_ACK');

    bob.ws.send(JSON.stringify({ type: 'ROOM_JOIN', target: { roomId: 'general' } }));
    await bob.waitForMessage((m) => m.type === 'ROOM_JOIN_ACK');

    // Bob leaves room
    bob.ws.send(
      JSON.stringify({
        type: 'ROOM_LEAVE',
        target: { roomId: 'general' },
        correlationId: 'leave-1'
      })
    );
    const leaveAck = await bob.waitForMessage((m) => m.type === 'ROOM_LEAVE_ACK');
    expect(leaveAck.correlationId).toBe('leave-1');
    expect(leaveAck.payload).toMatchObject({ roomId: 'general', status: 'LEFT' });

    // Alice sends message to general
    alice.ws.send(
      JSON.stringify({
        type: 'ROOM_MESSAGE',
        target: { roomId: 'general' },
        payload: { text: 'Anyone here?' }
      })
    );

    // Alice receives ack with recipientCount: 0
    const ack = await alice.waitForMessage((m) => m.type === 'DELIVERY_ACK');
    expect((ack.payload as any).recipientCount).toBe(0);

    // Bob should not receive message
    const bobMsg = bob.messages.find((m) => m.type === 'ROOM_MESSAGE');
    expect(bobMsg).toBeUndefined();

    alice.ws.close();
    bob.ws.close();
  });
});
