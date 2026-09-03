import { MessageDispatcher } from '../../src/core/MessageDispatcher.js';
import { ConnectionManager } from '../../src/core/ConnectionManager.js';
import { RoomManager } from '../../src/core/RoomManager.js';
import { Connection } from '../../src/core/Connection.js';
import { ChannelRegistry } from '../../src/redis/ChannelRegistry.js';
import { RedisPubSubManager } from '../../src/redis/RedisPubSubManager.js';
import { RedisConnectionManager } from '../../src/redis/RedisConnectionManager.js';
import RedisMock from 'ioredis-mock';
import { EventEmitter } from 'events';

describe('Redis Failure and Recovery Behavior', () => {
  const createMockSocket = () => {
    const socket: any = new EventEmitter();
    socket.readyState = 1; // OPEN
    socket.send = jest.fn();
    socket.close = jest.fn();
    socket.terminate = jest.fn();
    socket.bufferedAmount = 0;
    return socket;
  };

  test('node continues serving local messaging when Redis is completely unavailable', () => {
    const connManager = new ConnectionManager();
    const roomManager = new RoomManager();

    // PubSubManager pointing to an unavailable/disconnected Redis
    const failingPubSub = {
      isConnected: jest.fn().mockReturnValue(false),
      publish: jest.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379')),
      onMessage: jest.fn()
    };

    const dispatcher = new MessageDispatcher({
      connectionManager: connManager,
      roomManager,
      redisPubSubManager: failingPubSub as any,
      instanceId: 'node-isolated'
    });

    const socketAlice = createMockSocket();
    const socketBob = createMockSocket();

    const alice = new Connection({ socket: socketAlice, connectionId: 'c1', userId: 'alice' });
    const bob = new Connection({ socket: socketBob, connectionId: 'c2', userId: 'bob' });

    connManager.addConnection(alice);
    connManager.addConnection(bob);

    roomManager.joinRoom('standup', 'c1');
    roomManager.joinRoom('standup', 'c2');
    alice.joinRoom('standup');
    bob.joinRoom('standup');

    // Alice sends message during Redis outage
    const message = JSON.stringify({
      eventId: '018f673a-4421-7299-8d18-000000000041',
      type: 'ROOM_MESSAGE',
      target: { roomId: 'standup' },
      payload: { content: 'Local messaging during outage' }
    });

    expect(() => {
      dispatcher.dispatchRawMessage(alice, message);
    }).not.toThrow();

    // Local recipient (Bob) receives the message
    expect(socketBob.send).toHaveBeenCalledTimes(1);
    const delivered = JSON.parse(socketBob.send.mock.calls[0][0]);
    expect(delivered.payload.content).toBe('Local messaging during outage');

    // Local sender (Alice) receives ACK
    expect(socketAlice.send).toHaveBeenCalledTimes(1);
    const ack = JSON.parse(socketAlice.send.mock.calls[0][0]);
    expect(ack.type).toBe('DELIVERY_ACK');
    expect(ack.payload.status).toBe('ACCEPTED');
  });

  test('gracefully handles and logs Redis publish failure without crashing', async () => {
    const connManager = new ConnectionManager();
    const roomManager = new RoomManager();

    // Mock Redis that claims connected, but publish rejects with network error
    const rejectingPubSub = {
      isConnected: jest.fn().mockReturnValue(true),
      publish: jest.fn().mockRejectedValue(new Error('Connection lost to Redis broker')),
      onMessage: jest.fn()
    };

    const dispatcher = new MessageDispatcher({
      connectionManager: connManager,
      roomManager,
      redisPubSubManager: rejectingPubSub as any,
      instanceId: 'node-degraded'
    });

    const socketAlice = createMockSocket();
    const socketBob = createMockSocket();

    const alice = new Connection({ socket: socketAlice, connectionId: 'c1', userId: 'alice' });
    const bob = new Connection({ socket: socketBob, connectionId: 'c2', userId: 'bob' });

    connManager.addConnection(alice);
    connManager.addConnection(bob);

    roomManager.joinRoom('ops', 'c1');
    roomManager.joinRoom('ops', 'c2');
    alice.joinRoom('ops');
    bob.joinRoom('ops');

    const message = JSON.stringify({
      eventId: '018f673a-4421-7299-8d18-000000000042',
      type: 'ROOM_MESSAGE',
      target: { roomId: 'ops' },
      payload: { content: 'Message during network split' }
    });

    // Should not throw or crash
    dispatcher.dispatchRawMessage(alice, message);

    // Wait for any async unhandled rejections
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Local delivery succeeded
    expect(socketBob.send).toHaveBeenCalledTimes(1);
    expect(socketAlice.send).toHaveBeenCalledTimes(1);
  });

  test('restores channel subscriptions and resumes distributed flow after Redis reconnects', async () => {
    // Shared Redis broker
    const mockBroker = new RedisMock();
    const conn1 = new RedisConnectionManager({
      customClientFactory: () => mockBroker
    }, 'pulse-node-1');
    const pubSub1 = new RedisPubSubManager(conn1, 'pulse-node-1');
    await pubSub1.connect();

    const registry1 = new ChannelRegistry(pubSub1, 'pulse-node-1');
    const connManager1 = new ConnectionManager(registry1);
    const roomManager1 = new RoomManager(registry1);
    const dispatcher1 = new MessageDispatcher({
      connectionManager: connManager1,
      roomManager: roomManager1,
      redisPubSubManager: pubSub1,
      instanceId: 'pulse-node-1'
    });

    const socketAlice = createMockSocket();
    const alice = new Connection({ socket: socketAlice, connectionId: 'c1', userId: 'alice' });
    connManager1.addConnection(alice);
    roomManager1.joinRoom('engineering', 'c1');
    alice.joinRoom('engineering');

    expect(pubSub1.getSubscribedChannels()).toContain('pulse:room:engineering');

    // Simulate reconnection: trigger connectionManager 'connected' event
    const subscribeSpy = jest.spyOn(mockBroker, 'subscribe');
    conn1.emit('connected');

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Proven: active channels were re-subscribed upon recovery
    expect(subscribeSpy).toHaveBeenCalledWith('pulse:user:alice', 'pulse:room:engineering');

    await pubSub1.disconnect();
    mockBroker.disconnect();
  });
});
