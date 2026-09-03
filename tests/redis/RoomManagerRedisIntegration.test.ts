import { RoomManager } from '../../src/core/RoomManager.js';
import { ChannelRegistry } from '../../src/redis/ChannelRegistry.js';
import { RedisPubSubManager } from '../../src/redis/RedisPubSubManager.js';

describe('RoomManager & Redis Room Subscriptions Integration', () => {
  let mockPubSubManager: any;
  let channelRegistry: ChannelRegistry;
  let roomManager: RoomManager;

  beforeEach(() => {
    mockPubSubManager = {
      subscribe: jest.fn().mockResolvedValue(undefined),
      unsubscribe: jest.fn().mockResolvedValue(undefined)
    };

    channelRegistry = new ChannelRegistry(
      mockPubSubManager as unknown as RedisPubSubManager,
      'pulse-node-test'
    );

    roomManager = new RoomManager(channelRegistry);
  });

  test('preserves Phase 1 room behavior when ChannelRegistry is not attached', () => {
    const standaloneManager = new RoomManager();
    expect(standaloneManager.joinRoom('dev', 'conn-1')).toBe(true);
    expect(standaloneManager.isConnectionInRoom('dev', 'conn-1')).toBe(true);
    expect(standaloneManager.getConnectionCountInRoom('dev')).toBe(1);
    expect(standaloneManager.leaveRoom('dev', 'conn-1')).toBe(true);
    expect(standaloneManager.getRoomCount()).toBe(0);
  });

  test('triggers Redis subscribe on first local room join, and unsubscribe on last leave', async () => {
    const subscribeSpy = jest.spyOn(channelRegistry, 'subscribeRoom');
    const unsubscribeSpy = jest.spyOn(channelRegistry, 'unsubscribeRoom');

    // First member joins (0 -> 1)
    expect(roomManager.joinRoom('alpha', 'conn-1')).toBe(true);
    expect(subscribeSpy).toHaveBeenCalledWith('alpha');
    expect(channelRegistry.getRefCount('pulse:room:alpha')).toBe(1);
    expect(mockPubSubManager.subscribe).toHaveBeenCalledWith('pulse:room:alpha');

    // Second member joins same room (1 -> 2)
    expect(roomManager.joinRoom('alpha', 'conn-2')).toBe(true);
    expect(channelRegistry.getRefCount('pulse:room:alpha')).toBe(2);
    expect(mockPubSubManager.subscribe).toHaveBeenCalledTimes(1); // No second physical SUBSCRIBE

    // First member leaves (2 -> 1)
    expect(roomManager.leaveRoom('alpha', 'conn-1')).toBe(true);
    expect(unsubscribeSpy).toHaveBeenCalledWith('alpha');
    expect(channelRegistry.getRefCount('pulse:room:alpha')).toBe(1);
    expect(mockPubSubManager.unsubscribe).not.toHaveBeenCalled();

    // Last member leaves (1 -> 0)
    expect(roomManager.leaveRoom('alpha', 'conn-2')).toBe(true);
    expect(unsubscribeSpy).toHaveBeenCalledWith('alpha');
    expect(channelRegistry.getRefCount('pulse:room:alpha')).toBe(0);
    expect(mockPubSubManager.unsubscribe).toHaveBeenCalledWith('pulse:room:alpha');
  });

  test('cleans up room subscriptions on connection disconnect via removeConnectionFromAllRooms', async () => {
    roomManager.joinRooms(['room-1', 'room-2'], 'conn-1');
    roomManager.joinRoom('room-2', 'conn-2'); // room-2 has 2 members

    expect(channelRegistry.getRefCount('pulse:room:room-1')).toBe(1);
    expect(channelRegistry.getRefCount('pulse:room:room-2')).toBe(2);

    // conn-1 disconnects from all rooms
    const removed = roomManager.removeConnectionFromAllRooms('conn-1', ['room-1', 'room-2']);
    expect(removed).toContain('room-1');
    expect(removed).toContain('room-2');

    // room-1 had only conn-1 -> ref count becomes 0, unsubscribed
    expect(channelRegistry.getRefCount('pulse:room:room-1')).toBe(0);
    expect(mockPubSubManager.unsubscribe).toHaveBeenCalledWith('pulse:room:room-1');

    // room-2 still has conn-2 -> ref count becomes 1, NOT unsubscribed
    expect(channelRegistry.getRefCount('pulse:room:room-2')).toBe(1);
    expect(mockPubSubManager.unsubscribe).not.toHaveBeenCalledWith('pulse:room:room-2');
  });
});
