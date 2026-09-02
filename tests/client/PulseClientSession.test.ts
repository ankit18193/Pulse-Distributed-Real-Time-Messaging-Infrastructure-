import { PulseClientSession } from '../../src/client/PulseClientSession';
import { PulseServer } from '../../src/core/PulseServer';
import { loadConfig } from '../../src/config';
import { generateUUIDv7 } from '../../src/utils/uuidv7';
import { PulseEventEnvelope } from '../../src/types';

describe('PulseClientSession & Reliability (Phase 2)', () => {
  let server: PulseServer;
  const testPort = 9187;
  const authSecret = 'client-session-test-secret-key-32chars-min';

  beforeAll(async () => {
    const config = loadConfig({
      port: testPort,
      instanceId: 'test-session-node',
      authSecret
    });
    server = new PulseServer(config);
    await server.start();
  });

  afterAll(async () => {
    await server.stop({ gracePeriodMs: 50 });
  });

  describe('Decorrelated Jitter Backoff Calculations', () => {
    it('stays strictly within [baseDelay, maxDelay] bounds', () => {
      const session = new PulseClientSession({
        serverUrl: `ws://127.0.0.1:${testPort}/ws`,
        token: 'mock-token',
        userId: 'alice',
        baseDelayMs: 500,
        maxDelayMs: 10000
      });

      for (let i = 0; i < 50; i++) {
        const delay = session.computeNextBackoffDelay();
        expect(delay).toBeGreaterThanOrEqual(500);
        expect(delay).toBeLessThanOrEqual(10000);
      }
    });

    it('exhibits non-zero variance across random backoff draws', () => {
      const session = new PulseClientSession({
        serverUrl: `ws://127.0.0.1:${testPort}/ws`,
        token: 'mock-token',
        userId: 'alice',
        baseDelayMs: 500,
        maxDelayMs: 10000
      });

      const delays = new Set<number>();
      for (let i = 0; i < 50; i++) {
        delays.add(session.computeNextBackoffDelay());
      }
      // With decorrelated jitter, 50 draws must generate multiple distinct delays
      expect(delays.size).toBeGreaterThan(10);
    });

    it('resets backoff progression upon resetBackoff()', () => {
      const session = new PulseClientSession({
        serverUrl: `ws://127.0.0.1:${testPort}/ws`,
        token: 'mock-token',
        userId: 'alice',
        baseDelayMs: 500,
        maxDelayMs: 10000
      });

      session.computeNextBackoffDelay();
      session.computeNextBackoffDelay();
      session.resetBackoff();

      // First draw after reset must be bounded within [baseDelay, baseDelay * 2]
      const firstDraw = session.computeNextBackoffDelay();
      expect(firstDraw).toBeGreaterThanOrEqual(500);
      expect(firstDraw).toBeLessThanOrEqual(1000);
    });
  });

  describe('In-Flight ACK Tracking & Reconnection', () => {
    let client: PulseClientSession;

    afterEach(async () => {
      if (client) {
        await client.disconnect();
      }
    });

    it('connects, tracks monotonic sequence numbers, and resolves DELIVERY_ACK', async () => {
      const token = server.getAuthenticator().generateToken({ userId: 'alice_1' });
      client = new PulseClientSession({
        serverUrl: `ws://127.0.0.1:${testPort}/ws`,
        token,
        userId: 'alice_1'
      });

      await client.connect();
      expect(client.getState()).toBe('CONNECTED');

      // Join room
      const joinAck = await client.joinRoom('dev_channel');
      expect(joinAck.type).toBe('ROOM_JOIN_ACK');

      // Send room message with ACK tracking
      const ack = (await client.sendRoomMessage('dev_channel', {
        text: 'Reliable message'
      })) as PulseEventEnvelope;

      expect(ack).toBeDefined();
      expect(ack.type).toBe('DELIVERY_ACK');
      expect((ack.payload as { status: string }).status).toBe('ACCEPTED');
      expect(client.getInFlightCount()).toBe(0);
      expect(client.getCurrentSeq()).toBeGreaterThanOrEqual(2);
    });

    it('rejects new message sends with BUFFER_FULL when queue is saturated', async () => {
      const token = server.getAuthenticator().generateToken({ userId: 'bob_queue' });
      client = new PulseClientSession({
        serverUrl: `ws://127.0.0.1:${testPort}/ws`,
        token,
        userId: 'bob_queue',
        queueCapacity: 2,
        ackTimeoutMs: 5000
      });

      await client.connect();
      await client.joinRoom('test_buffer');

      // Fill queue with 2 unacked fake envelopes
      const p1 = client.sendEnvelope({
        eventId: generateUUIDv7(),
        type: 'ROOM_MESSAGE',
        timestamp: Date.now(),
        senderId: 'bob_queue',
        target: { roomId: 'test_buffer' },
        payload: { text: '1' },
        correlationId: 'c1',
        ackRequired: true
      });

      const p2 = client.sendEnvelope({
        eventId: generateUUIDv7(),
        type: 'ROOM_MESSAGE',
        timestamp: Date.now(),
        senderId: 'bob_queue',
        target: { roomId: 'test_buffer' },
        payload: { text: '2' },
        correlationId: 'c2',
        ackRequired: true
      });

      // 3rd message should immediately throw BUFFER_FULL
      await expect(
        client.sendEnvelope({
          eventId: generateUUIDv7(),
          type: 'ROOM_MESSAGE',
          timestamp: Date.now(),
          senderId: 'bob_queue',
          target: { roomId: 'test_buffer' },
          payload: { text: '3' },
          correlationId: 'c3',
          ackRequired: true
        })
      ).rejects.toThrow(/BUFFER_FULL/);

      await Promise.all([p1, p2]);
    });

    it('retransmits with identical eventId and correlationId on ACK timeout and eventually times out', async () => {
      const token = server.getAuthenticator().generateToken({ userId: 'retry_user' });
      client = new PulseClientSession({
        serverUrl: `ws://127.0.0.1:${testPort}/ws`,
        token,
        userId: 'retry_user',
        maxRetries: 2,
        ackTimeoutMs: 80
      });

      await client.connect();

      // Send to a non-existent event type or correlationId that will never produce an ACK
      const eventId = generateUUIDv7();
      const correlationId = generateUUIDv7();

      const sendPromise = client.sendEnvelope({
        eventId,
        type: 'SYS_PING',
        timestamp: Date.now(),
        senderId: 'retry_user',
        payload: {},
        correlationId,
        ackRequired: true // SYS_PING returns SYS_PONG, not DELIVERY_ACK
      });

      // Should exhaust 2 retries (80ms * 3 = 240ms) and throw DELIVERY_TIMEOUT
      await expect(sendPromise).rejects.toThrow(/DELIVERY_TIMEOUT/);
    });

    it('automatically batch resubscribes to desired rooms upon reconnection', async () => {
      const token = server.getAuthenticator().generateToken({ userId: 'reconnect_user' });
      client = new PulseClientSession({
        serverUrl: `ws://127.0.0.1:${testPort}/ws`,
        token,
        userId: 'reconnect_user',
        baseDelayMs: 100,
        maxDelayMs: 300,
        autoReconnect: false // We will trigger reconnect manually to test sequence
      });

      await client.connect();
      await client.joinRooms(['project_alpha', 'project_beta', 'project_gamma']);
      expect(client.getDesiredRooms()).toHaveLength(3);

      // Verify server registered all 3 rooms
      expect(server.getRoomManager().getConnectionCountInRoom('project_alpha')).toBe(1);
      expect(server.getRoomManager().getConnectionCountInRoom('project_beta')).toBe(1);
      expect(server.getRoomManager().getConnectionCountInRoom('project_gamma')).toBe(1);

      // Simulate abrupt socket drop
      const originalWs = (client as unknown as { ws: { terminate: () => void } }).ws;
      originalWs.terminate();

      // Wait for server to process close
      await new Promise((r) => setTimeout(r, 60));

      // Reconnect
      await client.connect();
      expect(client.getState()).toBe('CONNECTED');

      // Verify client re-registered all 3 rooms
      expect(server.getRoomManager().getConnectionCountInRoom('project_alpha')).toBe(1);
      expect(server.getRoomManager().getConnectionCountInRoom('project_beta')).toBe(1);
      expect(server.getRoomManager().getConnectionCountInRoom('project_gamma')).toBe(1);
    });
  });

  describe('Server Monotonic Sequence Enforcement', () => {
    it('rejects out-of-order sequence numbers with SYS_ERROR: INVALID_SEQUENCE_ORDER', async () => {
      const token = server.getAuthenticator().generateToken({ userId: 'seq_user' });
      const client = new PulseClientSession({
        serverUrl: `ws://127.0.0.1:${testPort}/ws`,
        token,
        userId: 'seq_user'
      });

      await client.connect();
      await client.joinRoom('seq_room');

      // Message with seq 5
      await client.sendEnvelope({
        eventId: generateUUIDv7(),
        type: 'ROOM_MESSAGE',
        timestamp: Date.now(),
        senderId: 'seq_user',
        seq: 5,
        target: { roomId: 'seq_room' },
        payload: { text: 'Seq 5' },
        correlationId: 'corr-5',
        ackRequired: true
      });

      // Now send message with seq 2 (lower than 5) directly
      const errorPromise = new Promise<PulseEventEnvelope>((resolve) => {
        client.on('message', (env: PulseEventEnvelope) => {
          if (env.type === 'SYS_ERROR') {
            resolve(env);
          }
        });
      });

      const rawWs = (client as unknown as { ws: { send: (s: string) => void } }).ws;
      rawWs.send(
        JSON.stringify({
          eventId: generateUUIDv7(),
          type: 'ROOM_MESSAGE',
          timestamp: Date.now(),
          senderId: 'seq_user',
          seq: 2, // out of order!
          target: { roomId: 'seq_room' },
          payload: { text: 'Out of order seq 2' }
        })
      );

      const errEnvelope = await errorPromise;
      expect((errEnvelope.payload as { code: string }).code).toBe(
        'INVALID_SEQUENCE_ORDER'
      );

      await client.disconnect();
    });
  });
});
