import { MessageDispatcher } from '../../src/core/MessageDispatcher.js';
import { ConnectionManager } from '../../src/core/ConnectionManager.js';
import { RoomManager } from '../../src/core/RoomManager.js';
import { Connection } from '../../src/core/Connection.js';
import { ChannelRegistry } from '../../src/redis/ChannelRegistry.js';
import { RedisPubSubManager } from '../../src/redis/RedisPubSubManager.js';
import { RedisConnectionManager } from '../../src/redis/RedisConnectionManager.js';
import RedisMock from 'ioredis-mock';
import { EventEmitter } from 'events';

describe('Cross-Node Direct Messaging (Node 1 -> Redis -> Node 2)', () => {
  // Node 1
  let connManager1: ConnectionManager;
  let roomManager1: RoomManager;
  let pubSub1: RedisPubSubManager;
  let dispatcher1: MessageDispatcher;

  // Node 2
  let connManager2: ConnectionManager;
  let roomManager2: RoomManager;
  let pubSub2: RedisPubSubManager;
  let dispatcher2: MessageDispatcher;

  const createMockSocket = () => {
    const socket: any = new EventEmitter();
    socket.readyState = 1; // OPEN
    socket.send = jest.fn();
    socket.close = jest.fn();
    socket.terminate = jest.fn();
    socket.bufferedAmount = 0;
    return socket;
  };

  beforeEach(async () => {
    // Setup Node 1
    const conn1 = new RedisConnectionManager({
      customClientFactory: () => new RedisMock()
    }, 'pulse-node-1');
    pubSub1 = new RedisPubSubManager(conn1, 'pulse-node-1');
    await pubSub1.connect();

    const registry1 = new ChannelRegistry(pubSub1, 'pulse-node-1');
    connManager1 = new ConnectionManager(registry1);
    roomManager1 = new RoomManager(registry1);
    dispatcher1 = new MessageDispatcher({
      connectionManager: connManager1,
      roomManager: roomManager1,
      redisPubSubManager: pubSub1,
      instanceId: 'pulse-node-1'
    });

    // Setup Node 2
    const conn2 = new RedisConnectionManager({
      customClientFactory: () => new RedisMock()
    }, 'pulse-node-2');
    pubSub2 = new RedisPubSubManager(conn2, 'pulse-node-2');
    await pubSub2.connect();

    const registry2 = new ChannelRegistry(pubSub2, 'pulse-node-2');
    connManager2 = new ConnectionManager(registry2);
    roomManager2 = new RoomManager(registry2);
    dispatcher2 = new MessageDispatcher({
      connectionManager: connManager2,
      roomManager: roomManager2,
      redisPubSubManager: pubSub2,
      instanceId: 'pulse-node-2'
    });
  });

  afterEach(async () => {
    await pubSub1.disconnect();
    await pubSub2.disconnect();
  });

  test('delivers direct message to all active connections of recipient on Node 2 and isolates other users', async () => {
    // 1. Client A (user_1) on Node 1
    const socketA = createMockSocket();
    const clientA = new Connection({
      socket: socketA,
      connectionId: 'conn-user1',
      userId: 'user_1'
    });
    connManager1.addConnection(clientA);

    // 2. Client B1 (user_2, phone) on Node 2
    const socketB1 = createMockSocket();
    const clientB1 = new Connection({
      socket: socketB1,
      connectionId: 'conn-user2-phone',
      userId: 'user_2'
    });
    connManager2.addConnection(clientB1);

    // 3. Client B2 (user_2, laptop) on Node 2
    const socketB2 = createMockSocket();
    const clientB2 = new Connection({
      socket: socketB2,
      connectionId: 'conn-user2-laptop',
      userId: 'user_2'
    });
    connManager2.addConnection(clientB2);

    // 4. Client C (user_3) on Node 2 (unrelated user)
    const socketC = createMockSocket();
    const clientC = new Connection({
      socket: socketC,
      connectionId: 'conn-user3',
      userId: 'user_3'
    });
    connManager2.addConnection(clientC);

    // Wait briefly for Redis user channel subscriptions
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 5. Client A sends DIRECT_MESSAGE targeted to user_2
    const dmEvent = {
      eventId: '018f673a-4421-7299-8d18-000000000020',
      type: 'DIRECT_MESSAGE',
      target: { recipientId: 'user_2' },
      payload: { text: 'Confidential message for user_2 only' }
    };

    dispatcher1.dispatchRawMessage(clientA, JSON.stringify(dmEvent));

    // Wait for Redis propagation to Node 2
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 6. Verification on Sender (Client A on Node 1):
    // Received DELIVERY_ACK, zero echo of message
    expect(socketA.send).toHaveBeenCalledTimes(1);
    const ackToA = JSON.parse(socketA.send.mock.calls[0][0]);
    expect(ackToA.type).toBe('DELIVERY_ACK');
    expect(ackToA.payload.status).toBe('ACCEPTED');
    expect(ackToA.payload.targetEventId).toBe('018f673a-4421-7299-8d18-000000000020');

    // 7. Verification on Recipient Devices (Client B1 and B2 on Node 2):
    // BOTH active connections of user_2 must receive the direct message
    expect(socketB1.send).toHaveBeenCalledTimes(1);
    const deliveredB1 = JSON.parse(socketB1.send.mock.calls[0][0]);
    expect(deliveredB1.type).toBe('DIRECT_MESSAGE');
    expect(deliveredB1.eventId).toBe('018f673a-4421-7299-8d18-000000000020');
    expect(deliveredB1.payload.text).toBe('Confidential message for user_2 only');
    expect(deliveredB1.originInstanceId).toBe('pulse-node-1');

    expect(socketB2.send).toHaveBeenCalledTimes(1);
    const deliveredB2 = JSON.parse(socketB2.send.mock.calls[0][0]);
    expect(deliveredB2.eventId).toBe('018f673a-4421-7299-8d18-000000000020');
    expect(deliveredB2.payload.text).toBe('Confidential message for user_2 only');

    // 8. Verification on Unrelated User (Client C on Node 2):
    // Must NOT receive the direct message
    expect(socketC.send).not.toHaveBeenCalled();
  });
});
