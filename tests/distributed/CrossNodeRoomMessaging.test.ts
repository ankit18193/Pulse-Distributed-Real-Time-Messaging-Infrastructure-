import { MessageDispatcher } from '../../src/core/MessageDispatcher.js';
import { ConnectionManager } from '../../src/core/ConnectionManager.js';
import { RoomManager } from '../../src/core/RoomManager.js';
import { Connection } from '../../src/core/Connection.js';
import { ChannelRegistry } from '../../src/redis/ChannelRegistry.js';
import { RedisPubSubManager } from '../../src/redis/RedisPubSubManager.js';
import { RedisConnectionManager } from '../../src/redis/RedisConnectionManager.js';
import RedisMock from 'ioredis-mock';
import { EventEmitter } from 'events';

describe('Cross-Node Room Messaging (Node 1 -> Redis -> Node 2)', () => {
  // Node 1 components
  let connManager1: ConnectionManager;
  let roomManager1: RoomManager;
  let pubSub1: RedisPubSubManager;
  let dispatcher1: MessageDispatcher;

  // Node 2 components
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

  test('delivers room message from Client A on Node 1 to Client B on Node 2 with zero echo to Client A', async () => {
    // 1. Client A connects to Node 1 and joins room "dev"
    const socketA = createMockSocket();
    const clientA = new Connection({
      socket: socketA,
      connectionId: 'conn-client-a',
      userId: 'alice'
    });
    connManager1.addConnection(clientA);
    roomManager1.joinRoom('dev', clientA.connectionId);
    clientA.joinRoom('dev');

    // 2. Client B connects to Node 2 and joins room "dev"
    const socketB = createMockSocket();
    const clientB = new Connection({
      socket: socketB,
      connectionId: 'conn-client-b',
      userId: 'bob'
    });
    connManager2.addConnection(clientB);
    roomManager2.joinRoom('dev', clientB.connectionId);
    clientB.joinRoom('dev');

    // 3. Client C connects to Node 1 but is NOT in room "dev"
    const socketC = createMockSocket();
    const clientC = new Connection({
      socket: socketC,
      connectionId: 'conn-client-c',
      userId: 'charlie'
    });
    connManager1.addConnection(clientC);

    // Wait briefly for Redis subscription wiring
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 4. Client A sends ROOM_MESSAGE to "dev"
    const messageEvent = {
      eventId: '018f673a-4421-7299-8d18-000000000010',
      type: 'ROOM_MESSAGE',
      target: { roomId: 'dev' },
      payload: { content: 'Hello cross-node room!' }
    };

    dispatcher1.dispatchRawMessage(clientA, JSON.stringify(messageEvent));

    // Wait for Redis propagation to Node 2
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 5. Verification on Client B (Node 2):
    // Client B must have received the ROOM_MESSAGE
    expect(socketB.send).toHaveBeenCalledTimes(1);
    const deliveredToB = JSON.parse(socketB.send.mock.calls[0][0]);
    expect(deliveredToB.type).toBe('ROOM_MESSAGE');
    expect(deliveredToB.eventId).toBe('018f673a-4421-7299-8d18-000000000010');
    expect(deliveredToB.payload.content).toBe('Hello cross-node room!');
    expect(deliveredToB.originInstanceId).toBe('pulse-node-1');

    // 6. Verification on Client A (Node 1 - Sender):
    // Client A must have received ONLY the DELIVERY_ACK, NOT an echo of its own message
    expect(socketA.send).toHaveBeenCalledTimes(1);
    const ackToA = JSON.parse(socketA.send.mock.calls[0][0]);
    expect(ackToA.type).toBe('DELIVERY_ACK');
    expect(ackToA.payload.status).toBe('ACCEPTED');
    expect(ackToA.payload.targetEventId).toBe('018f673a-4421-7299-8d18-000000000010');

    // 7. Verification on Client C (Node 1 - Non-member):
    // Client C was not in room "dev", so must have received nothing
    expect(socketC.send).not.toHaveBeenCalled();
  });
});
