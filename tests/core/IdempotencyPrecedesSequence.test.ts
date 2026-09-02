import { WebSocket } from 'ws';
import { PulseServer } from '../../src/core/PulseServer';
import { loadConfig } from '../../src/config';
import { generateUUIDv7 } from '../../src/utils/uuidv7';
import { PulseEventEnvelope } from '../../src/types';

describe('Idempotency Precedes Sequence Rejection (High-Severity Finding 1)', () => {
  let server: PulseServer;
  const testPort = 9191;
  const authSecret = 'finding1-idem-seq-test-secret-key-32chars-min';

  beforeAll(async () => {
    const config = loadConfig({
      port: testPort,
      instanceId: 'test-idem-seq-node',
      authSecret
    });
    server = new PulseServer(config);
    await server.start();
  });

  afterAll(async () => {
    await server.stop({ gracePeriodMs: 50 });
  });

  it('accepts seq 1 and seq 2, replays duplicate seq 1 without INVALID_SEQUENCE_ORDER or duplicate broadcast, and still rejects genuinely new event with seq < lastSeenSeq', async () => {
    const aliceToken = server.getAuthenticator().generateToken({ userId: 'alice_seq' });
    const bobToken = server.getAuthenticator().generateToken({ userId: 'bob_seq' });

    const aliceWs = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${aliceToken}`);
    const bobWs = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${bobToken}`);

    await Promise.all([
      new Promise<void>((r) => aliceWs.on('open', () => r())),
      new Promise<void>((r) => bobWs.on('open', () => r()))
    ]);

    // Track messages received by Bob
    const bobReceived: PulseEventEnvelope[] = [];
    bobWs.on('message', (data: Buffer | string) => {
      const env = JSON.parse(data.toString()) as PulseEventEnvelope;
      if (env.type === 'ROOM_MESSAGE') {
        bobReceived.push(env);
      }
    });

    // Helper to send frame and wait for response matching correlationId
    const sendAndAwaitResponse = (
      ws: WebSocket,
      frame: PulseEventEnvelope
    ): Promise<PulseEventEnvelope> => {
      return new Promise((resolve) => {
        const handler = (data: Buffer | string) => {
          const env = JSON.parse(data.toString()) as PulseEventEnvelope;
          if (env.correlationId === frame.correlationId) {
            ws.off('message', handler);
            resolve(env);
          }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify(frame));
      });
    };

    // Both join room 'idem_test_room'
    await Promise.all([
      sendAndAwaitResponse(aliceWs, {
        eventId: generateUUIDv7(),
        type: 'ROOM_JOIN',
        timestamp: Date.now(),
        senderId: 'alice_seq',
        target: { roomId: 'idem_test_room' },
        payload: { roomId: 'idem_test_room' },
        correlationId: 'join-alice'
      }),
      sendAndAwaitResponse(bobWs, {
        eventId: generateUUIDv7(),
        type: 'ROOM_JOIN',
        timestamp: Date.now(),
        senderId: 'bob_seq',
        target: { roomId: 'idem_test_room' },
        payload: { roomId: 'idem_test_room' },
        correlationId: 'join-bob'
      })
    ]);

    // 1. Seq 1 new event is accepted
    const eventId1 = generateUUIDv7();
    const ack1 = await sendAndAwaitResponse(aliceWs, {
      eventId: eventId1,
      type: 'ROOM_MESSAGE',
      timestamp: Date.now(),
      senderId: 'alice_seq',
      seq: 1,
      target: { roomId: 'idem_test_room' },
      payload: { text: 'Message 1' },
      correlationId: 'corr-seq-1',
      ackRequired: true
    });

    expect(ack1.type).toBe('DELIVERY_ACK');
    expect((ack1.payload as { status: string }).status).toBe('ACCEPTED');

    // 2. Seq 2 new event is accepted
    const eventId2 = generateUUIDv7();
    const ack2 = await sendAndAwaitResponse(aliceWs, {
      eventId: eventId2,
      type: 'ROOM_MESSAGE',
      timestamp: Date.now(),
      senderId: 'alice_seq',
      seq: 2,
      target: { roomId: 'idem_test_room' },
      payload: { text: 'Message 2' },
      correlationId: 'corr-seq-2',
      ackRequired: true
    });

    expect(ack2.type).toBe('DELIVERY_ACK');
    expect((ack2.payload as { status: string }).status).toBe('ACCEPTED');

    // Wait 50ms for Bob to receive both broadcasts
    await new Promise((r) => setTimeout(r, 50));
    expect(bobReceived).toHaveLength(2);
    expect(bobReceived[0].eventId).toBe(eventId1);
    expect(bobReceived[1].eventId).toBe(eventId2);

    // 3. Retransmission of Seq 1 with same eventId and payload:
    // Server sees 1 < lastSeenSeq (2), but recognizes duplicate eventId in IdempotencyManager!
    const replayedAck = await sendAndAwaitResponse(aliceWs, {
      eventId: eventId1,
      type: 'ROOM_MESSAGE',
      timestamp: Date.now(),
      senderId: 'alice_seq',
      seq: 1, // older sequence than lastSeenSeq (2)!
      target: { roomId: 'idem_test_room' },
      payload: { text: 'Message 1' },
      correlationId: 'corr-seq-1-retry',
      ackRequired: true
    });

    // - duplicate seq 1 does NOT produce INVALID_SEQUENCE_ORDER
    expect(replayedAck.type).toBe('DELIVERY_ACK');
    expect(replayedAck.correlationId).toBe('corr-seq-1-retry');
    expect((replayedAck.payload as { status: string }).status).toBe('ACCEPTED');

    // - duplicate does NOT broadcast a second message to Bob
    await new Promise((r) => setTimeout(r, 50));
    expect(bobReceived).toHaveLength(2);

    // 4. Genuinely NEW event with seq lower than lastSeenSeq (2) is still REJECTED
    const newLowSeqEventId = generateUUIDv7();
    const rejectedError = await sendAndAwaitResponse(aliceWs, {
      eventId: newLowSeqEventId,
      type: 'ROOM_MESSAGE',
      timestamp: Date.now(),
      senderId: 'alice_seq',
      seq: 1, // new event reusing old seq!
      target: { roomId: 'idem_test_room' },
      payload: { text: 'Genuinely new message with bad seq' },
      correlationId: 'corr-bad-seq',
      ackRequired: true
    });

    expect(rejectedError.type).toBe('SYS_ERROR');
    expect((rejectedError.payload as { code: string }).code).toBe('INVALID_SEQUENCE_ORDER');

    // Bob still receives nothing
    await new Promise((r) => setTimeout(r, 50));
    expect(bobReceived).toHaveLength(2);

    // 5. Valid new sequence progression (seq 3 > 2) succeeds
    const eventId3 = generateUUIDv7();
    const ack3 = await sendAndAwaitResponse(aliceWs, {
      eventId: eventId3,
      type: 'ROOM_MESSAGE',
      timestamp: Date.now(),
      senderId: 'alice_seq',
      seq: 3,
      target: { roomId: 'idem_test_room' },
      payload: { text: 'Message 3' },
      correlationId: 'corr-seq-3',
      ackRequired: true
    });

    expect(ack3.type).toBe('DELIVERY_ACK');
    await new Promise((r) => setTimeout(r, 50));
    expect(bobReceived).toHaveLength(3);
    expect(bobReceived[2].eventId).toBe(eventId3);

    aliceWs.close();
    bobWs.close();
  });
});
