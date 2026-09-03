import { MessageDispatcher } from '../../src/core/MessageDispatcher.js';
import { ConnectionManager } from '../../src/core/ConnectionManager.js';
import { RoomManager } from '../../src/core/RoomManager.js';
import { Connection } from '../../src/core/Connection.js';
import { IdempotencyManager } from '../../src/core/IdempotencyManager.js';
import { EventEmitter } from 'events';

describe('Harden Distributed Idempotency & Duplicate Handling', () => {
  let connectionManager: ConnectionManager;
  let roomManager: RoomManager;
  let idempotencyManager: IdempotencyManager;
  let mockPubSubManager: any;
  let dispatcher: MessageDispatcher;

  const createMockSocket = () => {
    const socket: any = new EventEmitter();
    socket.readyState = 1; // OPEN
    socket.send = jest.fn();
    socket.close = jest.fn();
    socket.terminate = jest.fn();
    socket.bufferedAmount = 0;
    return socket;
  };

  beforeEach(() => {
    connectionManager = new ConnectionManager();
    roomManager = new RoomManager();
    idempotencyManager = new IdempotencyManager({ capacity: 50, ttlMs: 60000 });

    mockPubSubManager = {
      isConnected: jest.fn().mockReturnValue(true),
      publish: jest.fn().mockResolvedValue(1),
      onMessage: jest.fn()
    };

    dispatcher = new MessageDispatcher({
      connectionManager,
      roomManager,
      idempotencyManager,
      redisPubSubManager: mockPubSubManager,
      instanceId: 'node-local'
    });
  });

  test('identical eventId arriving via Redis is deduplicated and delivered only once', () => {
    const socket = createMockSocket();
    const conn = new Connection({ socket, connectionId: 'c1', userId: 'alice' });
    connectionManager.addConnection(conn);
    roomManager.joinRoom('dev', 'c1');
    conn.joinRoom('dev');

    const distributedEvent = {
      eventId: '018f673a-4421-7299-8d18-000000000031',
      type: 'ROOM_MESSAGE',
      timestamp: Date.now(),
      senderId: 'remote-user',
      originInstanceId: 'node-remote',
      target: { roomId: 'dev' },
      payload: { text: 'Testing duplicate suppression across Redis' }
    };

    // First arrival via Redis -> processed and delivered to local socket
    const handled1 = dispatcher.handleInboundRedisEvent('pulse:room:dev', distributedEvent);
    expect(handled1).toBe(true);
    expect(socket.send).toHaveBeenCalledTimes(1);

    // Second arrival of same eventId via Redis -> detected as duplicate and suppressed
    const handled2 = dispatcher.handleInboundRedisEvent('pulse:room:dev', distributedEvent);
    expect(handled2).toBe(false);
    expect(socket.send).toHaveBeenCalledTimes(1); // Zero additional socket sends
  });

  test('duplicate publish from client retry replays cached ACK and skips duplicate Redis publish', () => {
    const socket = createMockSocket();
    const conn = new Connection({ socket, connectionId: 'c1', userId: 'alice' });
    connectionManager.addConnection(conn);
    roomManager.joinRoom('dev', 'c1');
    conn.joinRoom('dev');

    const clientFrame = JSON.stringify({
      eventId: '018f673a-4421-7299-8d18-000000000032',
      type: 'ROOM_MESSAGE',
      target: { roomId: 'dev' },
      payload: { text: 'Original client publish' },
      correlationId: 'req-1'
    });

    // 1. Initial client dispatch
    dispatcher.dispatchRawMessage(conn, clientFrame);
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(mockPubSubManager.publish).toHaveBeenCalledTimes(1);

    const firstAck = JSON.parse(socket.send.mock.calls[0][0]);
    expect(firstAck.type).toBe('DELIVERY_ACK');
    expect(firstAck.correlationId).toBe('req-1');

    // 2. Client retry of same frame (e.g. ACK dropped over network)
    const retryFrame = JSON.stringify({
      eventId: '018f673a-4421-7299-8d18-000000000032',
      type: 'ROOM_MESSAGE',
      target: { roomId: 'dev' },
      payload: { text: 'Original client publish' },
      correlationId: 'req-1'
    });

    dispatcher.dispatchRawMessage(conn, retryFrame);

    // Sender socket receives replayed ACK
    expect(socket.send).toHaveBeenCalledTimes(2);
    const replayedAck = JSON.parse(socket.send.mock.calls[1][0]);
    expect(replayedAck.type).toBe('DELIVERY_ACK');
    expect(replayedAck.payload.targetEventId).toBe('018f673a-4421-7299-8d18-000000000032');

    // CRITICAL: Redis publish was NOT invoked a second time!
    expect(mockPubSubManager.publish).toHaveBeenCalledTimes(1);
  });

  test('event ID conflict detection is preserved and rejects conflicting payload', () => {
    const socket = createMockSocket();
    const conn = new Connection({ socket, connectionId: 'c1', userId: 'alice' });
    connectionManager.addConnection(conn);
    roomManager.joinRoom('dev', 'c1');
    conn.joinRoom('dev');

    // Process valid event
    const validFrame = JSON.stringify({
      eventId: '018f673a-4421-7299-8d18-000000000033',
      type: 'ROOM_MESSAGE',
      target: { roomId: 'dev' },
      payload: { content: 'Original content' }
    });
    dispatcher.dispatchRawMessage(conn, validFrame);

    // Attempt to reuse same eventId with conflicting payload
    const conflictingFrame = JSON.stringify({
      eventId: '018f673a-4421-7299-8d18-000000000033',
      type: 'ROOM_MESSAGE',
      target: { roomId: 'dev' },
      payload: { content: 'Tampered or conflicting content' }
    });
    dispatcher.dispatchRawMessage(conn, conflictingFrame);

    // Sender socket receives EVENT_ID_CONFLICT error
    expect(socket.send).toHaveBeenCalledTimes(2);
    const errorFrame = JSON.parse(socket.send.mock.calls[1][0]);
    expect(errorFrame.type).toBe('SYS_ERROR');
    expect(errorFrame.payload.code).toBe('EVENT_ID_CONFLICT');

    // Redis was NOT published for the conflicting frame
    expect(mockPubSubManager.publish).toHaveBeenCalledTimes(1);
  });

  test('idempotency cache strictly bounds memory under distributed event load', () => {
    // Capacity configured to 50
    expect(idempotencyManager.getCapacity()).toBe(50);

    // Ingest 150 unique events via Redis
    for (let i = 0; i < 150; i++) {
      const event = {
        eventId: `018f673a-4421-7299-8d18-${String(i).padStart(12, '0')}`,
        type: 'ROOM_MESSAGE' as const,
        timestamp: Date.now(),
        senderId: 'remote-user',
        originInstanceId: 'node-remote',
        target: { roomId: 'general' },
        payload: { sequence: i }
      };

      dispatcher.handleInboundRedisEvent('pulse:room:general', event);
    }

    // Cache size must NOT exceed 50
    expect(idempotencyManager.size()).toBe(50);

    // Oldest items (0-99) were evicted
    const oldCheck = idempotencyManager.check('018f673a-4421-7299-8d18-000000000005', { sequence: 5 });
    expect(oldCheck.isDuplicate).toBe(false);

    // Most recent item (149) is retained
    const recentCheck = idempotencyManager.check('018f673a-4421-7299-8d18-000000000149', { sequence: 149 });
    expect(recentCheck.isDuplicate).toBe(true);
  });
});
