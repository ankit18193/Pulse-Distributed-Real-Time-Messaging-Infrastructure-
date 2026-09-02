import { PulseServer } from '../../src/core/PulseServer';
import { PulseClientSession } from '../../src/client/PulseClientSession';
import { loadConfig } from '../../src/config';
import { generateUUIDv7 } from '../../src/utils/uuidv7';
import { PulseEventEnvelope } from '../../src/types';

describe('Phase 2 — Reliability, Deduplication & Reconnection Acceptance Test', () => {
  let server: PulseServer;
  const testPort = 9190;
  const authSecret = 'phase2-acceptance-secret-key-32chars-min-required';

  beforeAll(async () => {
    const config = loadConfig({
      port: testPort,
      instanceId: 'pulse-phase2-acceptance',
      authSecret,
      idempotencyCapacity: 1000,
      idempotencyTtlMs: 30000
    });
    server = new PulseServer(config);
    await server.start();
  });

  afterAll(async () => {
    if (server.isServerRunning()) {
      await server.stop({ gracePeriodMs: 100 });
    }
  });

  it(
    'executes full Phase 2 reliability lifecycle: Batch Join -> Deduplication -> Conflicting Payload Rejection -> Abrupt Severance & Jitter Reconnection -> Graceful Shutdown',
    async () => {
    const aliceToken = server.getAuthenticator().generateToken({ userId: 'alice' });
    const bobToken = server.getAuthenticator().generateToken({ userId: 'bob' });
    const charlieToken = server.getAuthenticator().generateToken({ userId: 'charlie' });

    const serverUrl = `ws://127.0.0.1:${testPort}/ws`;

    // 1. Establish 3 client sessions
    const alice = new PulseClientSession({ serverUrl, token: aliceToken, userId: 'alice' });
    const bob = new PulseClientSession({
      serverUrl,
      token: bobToken,
      userId: 'bob',
      baseDelayMs: 50,
      maxDelayMs: 200,
      autoReconnect: true
    });
    const charlie = new PulseClientSession({ serverUrl, token: charlieToken, userId: 'charlie' });

    await Promise.all([alice.connect(), bob.connect(), charlie.connect()]);

    expect(alice.getState()).toBe('CONNECTED');
    expect(bob.getState()).toBe('CONNECTED');
    expect(charlie.getState()).toBe('CONNECTED');
    expect(server.getActiveConnectionCount()).toBe(3);

    // Track received messages for Bob and Charlie
    const bobReceived: PulseEventEnvelope[] = [];
    bob.on('message', (env: PulseEventEnvelope) => {
      if (env.type === 'ROOM_MESSAGE') {
        bobReceived.push(env);
      }
    });

    const charlieReceived: PulseEventEnvelope[] = [];
    charlie.on('message', (env: PulseEventEnvelope) => {
      if (env.type === 'ROOM_MESSAGE') {
        charlieReceived.push(env);
      }
    });

    // 2. Batch join rooms
    const sharedRooms = ['ops', 'general', 'lounge'];
    await Promise.all([
      alice.joinRooms(sharedRooms),
      bob.joinRooms(sharedRooms),
      charlie.joinRooms(sharedRooms)
    ]);

    for (const r of sharedRooms) {
      expect(server.getRoomManager().getConnectionCountInRoom(r)).toBe(3);
    }

    // 3. Alice sends message to 'ops' with specific UUIDv7 eventId
    const stableEventId = generateUUIDv7();
    const payload = { text: 'Deploying release 2.0.0' };

    const ack1 = (await alice.sendEnvelope({
      eventId: stableEventId,
      type: 'ROOM_MESSAGE',
      timestamp: Date.now(),
      senderId: 'alice',
      target: { roomId: 'ops' },
      payload,
      correlationId: 'corr-001',
      ackRequired: true
    })) as PulseEventEnvelope;

    expect(ack1.type).toBe('DELIVERY_ACK');
    expect((ack1.payload as { status: string }).status).toBe('ACCEPTED');

    await new Promise((r) => setTimeout(r, 60));
    expect(bobReceived).toHaveLength(1);
    expect(charlieReceived).toHaveLength(1);
    expect(bobReceived[0].eventId).toBe(stableEventId);

    // 4. Duplicate Message Suppression: Alice sends the EXACT same eventId and payload again
    const ack2 = (await alice.sendEnvelope({
      eventId: stableEventId,
      type: 'ROOM_MESSAGE',
      timestamp: Date.now(),
      senderId: 'alice',
      target: { roomId: 'ops' },
      payload,
      correlationId: 'corr-002',
      ackRequired: true
    })) as PulseEventEnvelope;

    expect(ack2.type).toBe('DELIVERY_ACK');
    expect((ack2.payload as { status: string }).status).toBe('ACCEPTED');

    await new Promise((r) => setTimeout(r, 60));
    // Bob and Charlie must still have only 1 message (duplicate was suppressed by server idempotency!)
    expect(bobReceived).toHaveLength(1);
    expect(charlieReceived).toHaveLength(1);

    // 5. Conflicting Payload Detection: Alice sends the same eventId with conflicting content
    const conflictPromise = new Promise<PulseEventEnvelope>((resolve) => {
      alice.on('message', (env: PulseEventEnvelope) => {
        if (env.type === 'SYS_ERROR') {
          resolve(env);
        }
      });
    });

    const rawAliceWs = (alice as unknown as { ws: { send: (s: string) => void } }).ws;
    rawAliceWs.send(
      JSON.stringify({
        eventId: stableEventId,
        type: 'ROOM_MESSAGE',
        timestamp: Date.now(),
        senderId: 'alice',
        target: { roomId: 'ops' },
        payload: { text: 'Conflicting tampered message content' }
      })
    );

    const conflictErr = await conflictPromise;
    expect((conflictErr.payload as { code: string }).code).toBe('EVENT_ID_CONFLICT');

    // 6. Abrupt Network Severance & Auto-Reconnect for Bob
    const bobReconnectedPromise = new Promise<void>((resolve) => {
      bob.on('connected', () => {
        resolve();
      });
    });

    // Abruptly terminate Bob's socket
    const rawBobWs = (bob as unknown as { ws: { terminate: () => void } }).ws;
    rawBobWs.terminate();

    // Bob detects severance, executes backoff with decorrelated jitter, reconnects and resubscribes
    await bobReconnectedPromise;
    expect(bob.getState()).toBe('CONNECTED');

    // Wait 50ms for server-side room mapping to settle
    await new Promise((r) => setTimeout(r, 50));

    // Verify Bob's rooms were restored
    expect(server.getRoomManager().isConnectionInRoom('ops', (bob as any).ws._socket ? (bob as any).ws : ''));
    expect(server.getRoomManager().getConnectionCountInRoom('ops')).toBe(3);

    // 7. Alice sends a post-reconnect message to 'ops'
    const postReconnectMsgId = generateUUIDv7();
    await alice.sendEnvelope({
      eventId: postReconnectMsgId,
      type: 'ROOM_MESSAGE',
      timestamp: Date.now(),
      senderId: 'alice',
      target: { roomId: 'ops' },
      payload: { text: 'Welcome back Bob' },
      ackRequired: true
    });

    await new Promise((r) => setTimeout(r, 60));
    // Bob should now have received the 2nd message!
    expect(bobReceived).toHaveLength(2);
    expect(bobReceived[1].eventId).toBe(postReconnectMsgId);

    // 8. Graceful Server Shutdown
    const bobClosePromise = new Promise<number>((resolve) => {
      (bob as unknown as { ws: { on: (e: string, fn: (c: number) => void) => void } }).ws.on(
        'close',
        (code) => resolve(code)
      );
    });

    (bob as any).autoReconnect = false;
    await server.stop({ gracePeriodMs: 100 });
    const closeCode = await bobClosePromise;
    expect(closeCode).toBe(1001); // 1001 Going Away

    await Promise.all([alice.disconnect(), bob.disconnect(), charlie.disconnect()]);
  }, 15000);
});
