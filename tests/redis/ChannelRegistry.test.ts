import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
  ChannelRegistry,
  getRoomChannel,
  getUserChannel,
  isRoomChannel,
  isUserChannel,
  isPresenceChannel,
  CHANNEL_PRESENCE_EVENTS,
  extractRoomId,
  extractUserId
} from '../../src/redis/ChannelRegistry.js';
import { RedisPubSubManager } from '../../src/redis/RedisPubSubManager.js';
import RedisMock from 'ioredis-mock';

describe('ChannelRegistry & Reference-Counted Subscriptions', () => {
  let mockPubSubManager: any;
  let registry: ChannelRegistry;
  let subscribeSpy: any;
  let unsubscribeSpy: any;

  beforeEach(() => {
    mockPubSubManager = {
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined)
    };

    subscribeSpy = mockPubSubManager.subscribe;
    unsubscribeSpy = mockPubSubManager.unsubscribe;

    registry = new ChannelRegistry(mockPubSubManager as unknown as RedisPubSubManager, 'pulse-node-test');
  });

  describe('Channel Naming and Parsers', () => {
    test('generates canonical room and user channels', () => {
      expect(getRoomChannel('engineering')).toBe('pulse:room:engineering');
      expect(getUserChannel('alice')).toBe('pulse:user:alice');
    });

    test('validates non-empty IDs', () => {
      expect(() => getRoomChannel('')).toThrow('Invalid roomId');
      expect(() => getUserChannel('')).toThrow('Invalid userId');
      expect(() => getRoomChannel('   ')).toThrow('Invalid roomId');
    });

    test('identifies and extracts IDs from channels', () => {
      expect(isRoomChannel('pulse:room:general')).toBe(true);
      expect(isRoomChannel('pulse:user:alice')).toBe(false);
      expect(isUserChannel('pulse:user:alice')).toBe(true);
      expect(isUserChannel('pulse:room:general')).toBe(false);

      expect(extractRoomId('pulse:room:general')).toBe('general');
      expect(extractRoomId('pulse:user:alice')).toBeNull();

      expect(extractUserId('pulse:user:bob')).toBe('bob');
      expect(extractUserId('pulse:room:general')).toBeNull();

      expect(isPresenceChannel('pulse:presence:events')).toBe(true);
      expect(isPresenceChannel('pulse:room:general')).toBe(false);
      expect(CHANNEL_PRESENCE_EVENTS).toBe('pulse:presence:events');
    });
  });

  describe('Reference Counting Transitions: 0 -> 1 -> 2 -> 1 -> 0', () => {
    test('proves exact lifecycle transitions for room channels', async () => {
      const roomId = 'engineering';
      const channel = 'pulse:room:engineering';

      // Transition 0 -> 1: First local member joins
      const subscribed1 = await registry.subscribeRoom(roomId);
      expect(subscribed1).toBe(true);
      expect(registry.getRefCount(channel)).toBe(1);
      expect(subscribeSpy).toHaveBeenCalledTimes(1);
      expect(subscribeSpy).toHaveBeenCalledWith(channel);

      // Transition 1 -> 2: Second local member joins same room
      const subscribed2 = await registry.subscribeRoom(roomId);
      expect(subscribed2).toBe(false);
      expect(registry.getRefCount(channel)).toBe(2);
      expect(subscribeSpy).toHaveBeenCalledTimes(1); // No second physical SUBSCRIBE!

      // Transition 2 -> 1: First member leaves, second member remains
      const unsubscribed1 = await registry.unsubscribeRoom(roomId);
      expect(unsubscribed1).toBe(false);
      expect(registry.getRefCount(channel)).toBe(1);
      expect(unsubscribeSpy).not.toHaveBeenCalled(); // No UNSUBSCRIBE while refCount > 0!

      // Transition 1 -> 0: Last member leaves
      const unsubscribed2 = await registry.unsubscribeRoom(roomId);
      expect(unsubscribed2).toBe(true);
      expect(registry.getRefCount(channel)).toBe(0);
      expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
      expect(unsubscribeSpy).toHaveBeenCalledWith(channel);

      // Extra unsubscribe call should be a safe no-op without negative leak
      const extraUnsub = await registry.unsubscribeRoom(roomId);
      expect(extraUnsub).toBe(false);
      expect(registry.getRefCount(channel)).toBe(0);
      expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
    });

    test('proves reference-counting lifecycle for user channels', async () => {
      const userId = 'alice_device_matrix';
      const channel = 'pulse:user:alice_device_matrix';

      // Device 1 connects (0 -> 1)
      const res1 = await registry.subscribeUser(userId);
      expect(res1).toBe(true);
      expect(registry.getRefCount(channel)).toBe(1);
      expect(subscribeSpy).toHaveBeenCalledWith(channel);

      // Device 2 connects (1 -> 2)
      const res2 = await registry.subscribeUser(userId);
      expect(res2).toBe(false);
      expect(registry.getRefCount(channel)).toBe(2);
      expect(subscribeSpy).toHaveBeenCalledTimes(1);

      // Device 1 disconnects (2 -> 1)
      const res3 = await registry.unsubscribeUser(userId);
      expect(res3).toBe(false);
      expect(registry.getRefCount(channel)).toBe(1);
      expect(unsubscribeSpy).not.toHaveBeenCalled();

      // Device 2 disconnects (1 -> 0)
      const res4 = await registry.unsubscribeUser(userId);
      expect(res4).toBe(true);
      expect(registry.getRefCount(channel)).toBe(0);
      expect(unsubscribeSpy).toHaveBeenCalledWith(channel);
    });

    test('tracks active channels and clears cleanly', async () => {
      await registry.subscribeRoom('alpha');
      await registry.subscribeRoom('beta');
      await registry.subscribeUser('user1');

      expect(registry.getActiveChannelCount()).toBe(3);
      expect(registry.getActiveChannels().sort()).toEqual([
        'pulse:room:alpha',
        'pulse:room:beta',
        'pulse:user:user1'
      ]);

      await registry.clear();

      expect(registry.getActiveChannelCount()).toBe(0);
      expect(registry.getActiveChannels()).toEqual([]);
      expect(unsubscribeSpy).toHaveBeenCalledWith('pulse:room:alpha');
      expect(unsubscribeSpy).toHaveBeenCalledWith('pulse:room:beta');
      expect(unsubscribeSpy).toHaveBeenCalledWith('pulse:user:user1');
    });

    test('rolls back reference count when physical Redis subscription fails and enables retry', async () => {
      const channel = 'pulse:room:flaky_room';

      // Mock pubSubManager.subscribe to fail once
      subscribeSpy.mockImplementationOnce(async () => {
        throw new Error('Redis subscription failed temporarily');
      });

      // Attempt 1: Should fail and rollback refCount to 0
      await expect(registry.subscribeRoom('flaky_room')).rejects.toThrow(
        'Redis subscription failed temporarily'
      );
      expect(registry.getRefCount(channel)).toBe(0);

      // Attempt 2: Retry should attempt 0 -> 1 transition again and succeed
      const retrySuccess = await registry.subscribeRoom('flaky_room');
      expect(retrySuccess).toBe(true);
      expect(registry.getRefCount(channel)).toBe(1);
    });

    test('proves exact lifecycle transitions for cluster presence channel', async () => {
      expect(registry.isPresenceSubscribed()).toBe(false);

      // 0 -> 1: First subscriber
      const res1 = await registry.subscribePresence();
      expect(res1).toBe(true);
      expect(subscribeSpy).toHaveBeenCalledWith('pulse:presence:events');
      expect(registry.isPresenceSubscribed()).toBe(true);
      expect(registry.getRefCount('pulse:presence:events')).toBe(1);

      // 1 -> 2: Second subscriber
      const res2 = await registry.subscribePresence();
      expect(res2).toBe(false);
      expect(subscribeSpy).toHaveBeenCalledTimes(1);
      expect(registry.getRefCount('pulse:presence:events')).toBe(2);

      // 2 -> 1: First unsubscriber
      const unsub1 = await registry.unsubscribePresence();
      expect(unsub1).toBe(false);
      expect(unsubscribeSpy).not.toHaveBeenCalled();
      expect(registry.getRefCount('pulse:presence:events')).toBe(1);

      // 1 -> 0: Final unsubscriber
      const unsub2 = await registry.unsubscribePresence();
      expect(unsub2).toBe(true);
      expect(unsubscribeSpy).toHaveBeenCalledWith('pulse:presence:events');
      expect(registry.isPresenceSubscribed()).toBe(false);
      expect(registry.getRefCount('pulse:presence:events')).toBe(0);
    });
  });
});
