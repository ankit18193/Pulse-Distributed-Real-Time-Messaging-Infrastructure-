import { ConnectionManager } from '../../src/core/ConnectionManager.js';
import { Connection } from '../../src/core/Connection.js';
import { ChannelRegistry } from '../../src/redis/ChannelRegistry.js';
import { RedisPubSubManager } from '../../src/redis/RedisPubSubManager.js';
import { EventEmitter } from 'events';

describe('ConnectionManager & Redis User Subscriptions Integration', () => {
  let mockPubSubManager: any;
  let channelRegistry: ChannelRegistry;
  let connectionManager: ConnectionManager;

  const createMockSocket = () => {
    const socket: any = new EventEmitter();
    socket.send = jest.fn();
    socket.close = jest.fn();
    socket.terminate = jest.fn();
    socket.bufferedAmount = 0;
    return socket;
  };

  beforeEach(() => {
    mockPubSubManager = {
      subscribe: jest.fn().mockResolvedValue(undefined),
      unsubscribe: jest.fn().mockResolvedValue(undefined)
    };

    channelRegistry = new ChannelRegistry(
      mockPubSubManager as unknown as RedisPubSubManager,
      'pulse-node-test'
    );

    connectionManager = new ConnectionManager(channelRegistry);
  });

  test('preserves standalone Phase 1 behavior when ChannelRegistry is not attached', () => {
    const standalone = new ConnectionManager();
    const conn = new Connection({
      socket: createMockSocket(),
      connectionId: 'conn-1',
      userId: 'alice',
      roles: ['user']
    });

    standalone.addConnection(conn);
    expect(standalone.getConnection('conn-1')).toBe(conn);
    expect(standalone.getConnectionsByUserId('alice')).toHaveLength(1);
    expect(standalone.removeConnection('conn-1')).toBe(conn);
    expect(standalone.getCount()).toBe(0);
  });

  test('subscribes user channel on first connection, unsubscribes on last disconnect', async () => {
    const subscribeSpy = jest.spyOn(channelRegistry, 'subscribeUser');
    const unsubscribeSpy = jest.spyOn(channelRegistry, 'unsubscribeUser');

    const conn1 = new Connection({
      socket: createMockSocket(),
      connectionId: 'conn-1',
      userId: 'bob',
      roles: ['user']
    });
    const conn2 = new Connection({
      socket: createMockSocket(),
      connectionId: 'conn-2',
      userId: 'bob',
      roles: ['user']
    });

    // Device 1 connects (0 -> 1)
    connectionManager.addConnection(conn1);
    expect(subscribeSpy).toHaveBeenCalledWith('bob');
    expect(channelRegistry.getRefCount('pulse:user:bob')).toBe(1);
    expect(mockPubSubManager.subscribe).toHaveBeenCalledWith('pulse:user:bob');

    // Device 2 connects for same user (1 -> 2)
    connectionManager.addConnection(conn2);
    expect(channelRegistry.getRefCount('pulse:user:bob')).toBe(2);
    expect(mockPubSubManager.subscribe).toHaveBeenCalledTimes(1); // No duplicate Redis SUBSCRIBE

    // Device 1 disconnects (2 -> 1)
    connectionManager.removeConnection('conn-1');
    expect(unsubscribeSpy).toHaveBeenCalledWith('bob');
    expect(channelRegistry.getRefCount('pulse:user:bob')).toBe(1);
    expect(mockPubSubManager.unsubscribe).not.toHaveBeenCalled(); // Still subscribed!

    // Device 2 disconnects (1 -> 0)
    connectionManager.removeConnection('conn-2');
    expect(unsubscribeSpy).toHaveBeenCalledWith('bob');
    expect(channelRegistry.getRefCount('pulse:user:bob')).toBe(0);
    expect(mockPubSubManager.unsubscribe).toHaveBeenCalledWith('pulse:user:bob');
  });

  test('maintains independent channels for different users', async () => {
    const connAlice = new Connection({
      socket: createMockSocket(),
      connectionId: 'conn-a',
      userId: 'alice',
      roles: ['user']
    });
    const connCharlie = new Connection({
      socket: createMockSocket(),
      connectionId: 'conn-c',
      userId: 'charlie',
      roles: ['user']
    });

    connectionManager.addConnection(connAlice);
    connectionManager.addConnection(connCharlie);

    expect(channelRegistry.getRefCount('pulse:user:alice')).toBe(1);
    expect(channelRegistry.getRefCount('pulse:user:charlie')).toBe(1);

    connectionManager.removeConnection('conn-a');
    expect(channelRegistry.getRefCount('pulse:user:alice')).toBe(0);
    expect(channelRegistry.getRefCount('pulse:user:charlie')).toBe(1);
    expect(mockPubSubManager.unsubscribe).toHaveBeenCalledWith('pulse:user:alice');
    expect(mockPubSubManager.unsubscribe).not.toHaveBeenCalledWith('pulse:user:charlie');
  });
});
