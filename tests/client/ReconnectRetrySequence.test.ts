import { WebSocket } from 'ws';
import { PulseServer } from '../../src/core/PulseServer';
import { PulseClientSession } from '../../src/client/PulseClientSession';
import { loadConfig } from '../../src/config';
import { generateUUIDv7 } from '../../src/utils/uuidv7';
import { PulseEventEnvelope } from '../../src/types';

describe('Reconnect Retries Use New Connection Sequence (High-Severity Finding 2)', () => {
  let server: PulseServer;
  const testPort = 9192;
  const authSecret = 'finding2-reconnect-seq-secret-key-32chars-min';

  beforeAll(async () => {
    const config = loadConfig({
      port: testPort,
      instanceId: 'test-reconnect-seq-node',
      authSecret
    });
    server = new PulseServer(config);
    await server.start();
  });

  afterAll(async () => {
    await server.stop({ gracePeriodMs: 50 });
  });

  it('re-sequences unacknowledged retries on new connection, preserves eventId/correlationId, and resolves cleanly without duplicate broadcast', async () => {
    const aliceToken = server.getAuthenticator().generateToken({ userId: 'alice_rec' });
    const bobToken = server.getAuthenticator().generateToken({ userId: 'bob_rec' });

    // Bob connects via raw WebSocket to observe broadcasts in 'recovery_room'
    const bobWs = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${bobToken}`);
    await new Promise<void>((r) => bobWs.on('open', () => r()));

    const bobReceived: PulseEventEnvelope[] = [];
    bobWs.on('message', (data: Buffer | string) => {
      const env = JSON.parse(data.toString()) as PulseEventEnvelope;
      if (env.type === 'ROOM_MESSAGE') {
        bobReceived.push(env);
      }
    });

    // Bob joins 'recovery_room'
    bobWs.send(
      JSON.stringify({
        eventId: generateUUIDv7(),
        type: 'ROOM_JOIN',
        timestamp: Date.now(),
        senderId: 'bob_rec',
        target: { roomId: 'recovery_room' },
        payload: { roomId: 'recovery_room' },
        correlationId: 'bob-join'
      })
    );
    await new Promise((r) => setTimeout(r, 50));

    // Alice connects via PulseClientSession (Connection A)
    const alice = new PulseClientSession({
      serverUrl: `ws://127.0.0.1:${testPort}/ws`,
      token: aliceToken,
      userId: 'alice_rec',
      autoReconnect: false, // manual control for deterministic test steps
      ackTimeoutMs: 1500
    });

    await alice.connect();
    expect(alice.getState()).toBe('CONNECTED');

    // Alice joins 'recovery_room' on Connection A
    await alice.joinRooms(['recovery_room']);

    // Track any errors emitted by Alice
    const errors: unknown[] = [];
    alice.on('error', (err) => errors.push(err));

    // 1. Send Message 1 on Connection A (successfully acknowledged)
    const eventId1 = generateUUIDv7();
    const ack1 = await alice.sendEnvelope({
      eventId: eventId1,
      type: 'ROOM_MESSAGE',
      timestamp: Date.now(),
      senderId: 'alice_rec',
      target: { roomId: 'recovery_room' },
      payload: { text: 'Connection A message 1' },
      correlationId: 'corr-conn-a-1',
      ackRequired: true
    });
    expect((ack1 as PulseEventEnvelope).type).toBe('DELIVERY_ACK');

    // 2. Prepare Message 2 and leave in-flight
    const eventId2 = generateUUIDv7();
    const correlationId2 = 'corr-in-flight-2';

    // Disconnect listener to drop connection A right after sending
    const inFlightPromise = alice.sendEnvelope({
      eventId: eventId2,
      type: 'ROOM_MESSAGE',
      timestamp: Date.now(),
      senderId: 'alice_rec',
      target: { roomId: 'recovery_room' },
      payload: { text: 'In-flight message across severance' },
      correlationId: correlationId2,
      ackRequired: true
    });

    // 3. Force connection A to close abruptly
    const rawAliceWsA = (alice as unknown as { ws: { terminate: () => void } }).ws;
    rawAliceWsA.terminate();

    // Give server time to process disconnect of Connection A
    await new Promise((r) => setTimeout(r, 60));
    expect(server.getActiveConnectionCount()).toBe(1); // only Bob left
    expect(alice.getInFlightCount()).toBe(1); // Message 2 still in-flight in queue

    // 4. Establish Connection B
    await alice.connect();
    expect(alice.getState()).toBe('CONNECTED');

    // Wait for in-flight promise to resolve via Connection B retry flush
    const ack2 = (await inFlightPromise) as PulseEventEnvelope;

    // 7. Verify the retry is accepted rather than rejected with INVALID_SEQUENCE_ORDER
    expect(ack2).toBeDefined();
    expect(ack2.type).toBe('DELIVERY_ACK');
    expect((ack2.payload as { status: string }).status).toBe('ACCEPTED');

    // 8. Verify the retry keeps the SAME eventId
    expect((ack2.payload as { targetEventId: string }).targetEventId).toBe(eventId2);

    // 9. Verify the retry keeps the SAME correlationId
    expect(ack2.correlationId).toBe(correlationId2);

    // 10. Verify the retry does not cause duplicate delivery/broadcast because IdempotencyManager recognizes the original event
    await new Promise((r) => setTimeout(r, 60));
    const receivedEventIds = bobReceived.map((m) => m.eventId);
    // Message 1 was delivered once; Message 2 was delivered once (no duplicates)
    expect(bobReceived).toHaveLength(2);
    expect(receivedEventIds).toContain(eventId1);
    expect(receivedEventIds).toContain(eventId2);

    // 11. Verify sequence numbers on connection B are valid and monotonic
    // On Connection B: client generated seq 1 for batch join, seq 2 for flushed retry
    expect(alice.getCurrentSeq()).toBe(2);

    // Send a new message on Connection B to verify monotonic continuation
    const eventId3 = generateUUIDv7();
    const ack3 = await alice.sendEnvelope({
      eventId: eventId3,
      type: 'ROOM_MESSAGE',
      timestamp: Date.now(),
      senderId: 'alice_rec',
      target: { roomId: 'recovery_room' },
      payload: { text: 'Connection B subsequent message 3' },
      correlationId: 'corr-conn-b-3',
      ackRequired: true
    });
    expect((ack3 as PulseEventEnvelope).type).toBe('DELIVERY_ACK');

    // On Connection B: client advanced to seq 3, server accepted and updated lastSeenSeq to 3
    expect(alice.getCurrentSeq()).toBe(3);
    const activeConns = server.getConnectionManager().getConnectionsByUserId('alice_rec');
    expect(activeConns).toHaveLength(1);
    const connB = activeConns[0];
    expect(connB.lastSeenSeq).toBe(3);

    await new Promise((r) => setTimeout(r, 60));
    expect(bobReceived).toHaveLength(3);

    // No errors occurred
    expect(errors).toHaveLength(0);

    bobWs.close();
    await alice.disconnect();
  });
});
