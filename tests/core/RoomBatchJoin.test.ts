import { WebSocket } from 'ws';
import { PulseServer } from '../../src/core/PulseServer';
import { loadConfig } from '../../src/config';
import { PulseEventEnvelope } from '../../src/types';
import { generateUUIDv7 } from '../../src/utils/uuidv7';

describe('ROOM_BATCH_JOIN & Resubscription (Phase 2)', () => {
  let server: PulseServer;
  const testPort = 9186;
  const authSecret = 'batch-join-test-secret-min-32-characters-required';

  beforeAll(async () => {
    const config = loadConfig({
      port: testPort,
      instanceId: 'test-batch-node',
      authSecret
    });
    server = new PulseServer(config);
    await server.start();
  });

  afterAll(async () => {
    await server.stop({ gracePeriodMs: 50 });
  });

  async function createClient(userId: string): Promise<{
    ws: WebSocket;
    messages: PulseEventEnvelope[];
    waitForType: (type: string) => Promise<PulseEventEnvelope>;
    close: () => Promise<void>;
  }> {
    const token = server.getAuthenticator().generateToken({ userId });
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${token}`);
    const messages: PulseEventEnvelope[] = [];

    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()));
    });

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', (err) => reject(err));
    });

    const waitForType = (type: string): Promise<PulseEventEnvelope> => {
      return new Promise((resolve) => {
        const existing = messages.find((m) => m.type === type);
        if (existing) {
          return resolve(existing);
        }
        const handler = (data: Buffer | string) => {
          const parsed = JSON.parse(data.toString()) as PulseEventEnvelope;
          if (parsed.type === type) {
            ws.off('message', handler);
            resolve(parsed);
          }
        };
        ws.on('message', handler);
      });
    };

    const close = async () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    return { ws, messages, waitForType, close };
  }

  it('joins multiple rooms atomically and receives ROOM_BATCH_JOIN_ACK', async () => {
    const client = await createClient('user_batch_1');
    await client.waitForType('SYS_CONNECT_ACK');

    const rooms = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    const batchJoinEvent: PulseEventEnvelope = {
      eventId: generateUUIDv7(),
      type: 'ROOM_BATCH_JOIN',
      timestamp: Date.now(),
      senderId: 'user_batch_1',
      payload: { rooms }
    };

    client.ws.send(JSON.stringify(batchJoinEvent));

    const ack = await client.waitForType('ROOM_BATCH_JOIN_ACK');
    expect(ack).toBeDefined();
    const payload = ack.payload as { joinedRooms: string[]; totalJoined: number };
    expect(payload.joinedRooms).toEqual(rooms);
    expect(payload.totalJoined).toBe(5);

    // Verify room manager has the connection in all 5 rooms
    for (const r of rooms) {
      expect(server.getRoomManager().getConnectionCountInRoom(r)).toBe(1);
    }

    await client.close();
  });

  it('receives broadcasts sent to any batch-joined room', async () => {
    const client1 = await createClient('listener_1');
    await client1.waitForType('SYS_CONNECT_ACK');

    // Batch join 3 rooms
    client1.ws.send(
      JSON.stringify({
        eventId: generateUUIDv7(),
        type: 'ROOM_BATCH_JOIN',
        timestamp: Date.now(),
        senderId: 'listener_1',
        payload: { rooms: ['eng', 'sales', 'random'] }
      })
    );
    await client1.waitForType('ROOM_BATCH_JOIN_ACK');

    // Client 2 sends to 'sales'
    const client2 = await createClient('sender_sales');
    await client2.waitForType('SYS_CONNECT_ACK');

    // Client 2 joins 'sales'
    client2.ws.send(
      JSON.stringify({
        eventId: generateUUIDv7(),
        type: 'ROOM_JOIN',
        timestamp: Date.now(),
        senderId: 'sender_sales',
        target: { roomId: 'sales' },
        payload: {}
      })
    );
    await client2.waitForType('ROOM_JOIN_ACK');

    // Client 2 broadcasts to 'sales'
    client2.ws.send(
      JSON.stringify({
        eventId: generateUUIDv7(),
        type: 'ROOM_MESSAGE',
        timestamp: Date.now(),
        senderId: 'sender_sales',
        target: { roomId: 'sales' },
        payload: { text: 'Q3 target reached' }
      })
    );

    const receivedMessage = await client1.waitForType('ROOM_MESSAGE');
    expect(receivedMessage).toBeDefined();
    expect(receivedMessage.target?.roomId).toBe('sales');
    expect((receivedMessage.payload as { text: string }).text).toBe('Q3 target reached');

    await client1.close();
    await client2.close();
  });

  it('rejects ROOM_BATCH_JOIN exceeding 50 rooms with BATCH_SIZE_EXCEEDED', async () => {
    const client = await createClient('overflow_user');
    await client.waitForType('SYS_CONNECT_ACK');

    const excessiveRooms: string[] = [];
    for (let i = 1; i <= 51; i++) {
      excessiveRooms.push(`room_${i}`);
    }

    client.ws.send(
      JSON.stringify({
        eventId: generateUUIDv7(),
        type: 'ROOM_BATCH_JOIN',
        timestamp: Date.now(),
        senderId: 'overflow_user',
        payload: { rooms: excessiveRooms }
      })
    );

    const error = await client.waitForType('SYS_ERROR');
    expect(error).toBeDefined();
    expect((error.payload as { code: string }).code).toBe('BATCH_SIZE_EXCEEDED');

    await client.close();
  });

  it('rejects empty or malformed rooms payload with INVALID_ROOMS_ARRAY', async () => {
    const client = await createClient('invalid_batch_user');
    await client.waitForType('SYS_CONNECT_ACK');

    client.ws.send(
      JSON.stringify({
        eventId: generateUUIDv7(),
        type: 'ROOM_BATCH_JOIN',
        timestamp: Date.now(),
        senderId: 'invalid_batch_user',
        payload: { rooms: [] }
      })
    );

    const error = await client.waitForType('SYS_ERROR');
    expect(error).toBeDefined();
    expect((error.payload as { code: string }).code).toBe('INVALID_ROOMS_ARRAY');

    await client.close();
  });
});
