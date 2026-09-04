import {
  executeRegisterPresence,
  executeRemovePresence,
  executeGetRoomPresenceRoster,
  getPresenceUserKey,
  getRoomMembersKey,
  formatPresenceMember,
  parsePresenceMember
} from '../../src/redis/PresenceLuaScripts.js';
import RedisMock from 'ioredis-mock';

describe('PresenceLuaScripts Unit & Atomic Operations', () => {
  let redis: any;

  beforeEach(() => {
    redis = new RedisMock();
  });

  afterEach(async () => {
    await redis.flushall();
  });

  describe('Key and Member Helpers', () => {
    test('generates canonical keys correctly', () => {
      expect(getPresenceUserKey('alice')).toBe('pulse:presence:user:alice');
      expect(getRoomMembersKey('general')).toBe('pulse:room:general:members');
    });

    test('validates non-empty input for keys', () => {
      expect(() => getPresenceUserKey('')).toThrow('Invalid userId');
      expect(() => getPresenceUserKey('   ')).toThrow('Invalid userId');
      expect(() => getRoomMembersKey('')).toThrow('Invalid roomId');
      expect(() => getRoomMembersKey('   ')).toThrow('Invalid roomId');
    });

    test('formats and parses presence members reliably', () => {
      const member = formatPresenceMember('pulse-node-1', 'conn_abc123');
      expect(member).toBe('pulse-node-1:conn_abc123');

      const parsed = parsePresenceMember(member);
      expect(parsed).toEqual({
        instanceId: 'pulse-node-1',
        connectionId: 'conn_abc123'
      });

      expect(parsePresenceMember('')).toBeNull();
      expect(parsePresenceMember('invalidformat')).toBeNull();
    });
  });

  describe('REGISTER_PRESENCE Atomic Transitions', () => {
    test('detects 0 -> 1 transition (ONLINE) for first connection', async () => {
      const now = Date.now();
      const expireAt = now + 60000;

      const result = await executeRegisterPresence(
        redis,
        'alice',
        'pulse-node-1',
        'conn_1',
        expireAt,
        now
      );

      // Returns 1 indicating 0 -> 1 (ONLINE)
      expect(result).toBe(1);

      // ZSET should contain the connection
      const key = getPresenceUserKey('alice');
      const members = await redis.zrangebyscore(key, now, '+inf');
      expect(members).toEqual(['pulse-node-1:conn_1']);
    });

    test('returns 0 for subsequent connections (1 -> N) of the same user', async () => {
      const now = Date.now();
      const expireAt = now + 60000;

      // First device connects (0 -> 1)
      const res1 = await executeRegisterPresence(
        redis,
        'alice',
        'pulse-node-1',
        'conn_1',
        expireAt,
        now
      );
      expect(res1).toBe(1);

      // Second device connects on same or different instance (1 -> 2)
      const res2 = await executeRegisterPresence(
        redis,
        'alice',
        'pulse-node-2',
        'conn_2',
        expireAt,
        now
      );
      // Returns 0 indicating already online
      expect(res2).toBe(0);

      // Third device connects (2 -> 3)
      const res3 = await executeRegisterPresence(
        redis,
        'alice',
        'pulse-node-1',
        'conn_3',
        expireAt,
        now
      );
      expect(res3).toBe(0);

      const key = getPresenceUserKey('alice');
      const count = await redis.zcard(key);
      expect(count).toBe(3);
    });

    test('prunes expired leases on registration and returns 1 if all prior leases expired', async () => {
      const t0 = 100000;
      const expiredTime = t0 + 10000; // expired at t = 110000

      // Add an initial lease that expires at 110000
      await executeRegisterPresence(
        redis,
        'bob',
        'pulse-node-1',
        'conn_old',
        expiredTime,
        t0
      );

      // Now at t = 120000, old lease has expired!
      const tNow = 120000;
      const newExpire = tNow + 60000;

      const result = await executeRegisterPresence(
        redis,
        'bob',
        'pulse-node-1',
        'conn_new',
        newExpire,
        tNow
      );

      // Because the old lease was pruned, countBefore was 0 -> returns 1 (ONLINE transition)
      expect(result).toBe(1);

      const key = getPresenceUserKey('bob');
      const members = await redis.zrangebyscore(key, tNow, '+inf');
      expect(members).toEqual(['pulse-node-1:conn_new']);
    });
  });

  describe('REMOVE_PRESENCE Atomic Transitions', () => {
    test('detects 1 -> 0 transition (OFFLINE) and cleans key when final connection is removed', async () => {
      const now = Date.now();
      const expireAt = now + 60000;

      await executeRegisterPresence(
        redis,
        'alice',
        'pulse-node-1',
        'conn_1',
        expireAt,
        now
      );

      // Remove the only connection
      const removeRes = await executeRemovePresence(
        redis,
        'alice',
        'pulse-node-1',
        'conn_1',
        now
      );

      // Returns 1 indicating 1 -> 0 (OFFLINE transition)
      expect(removeRes).toBe(1);

      // Key should be deleted
      const key = getPresenceUserKey('alice');
      const exists = await redis.exists(key);
      expect(exists).toBe(0);
    });

    test('returns 0 for N -> 1 when other devices remain online', async () => {
      const now = Date.now();
      const expireAt = now + 60000;

      // Register two devices across different instances
      await executeRegisterPresence(redis, 'alice', 'pulse-node-1', 'conn_mobile', expireAt, now);
      await executeRegisterPresence(redis, 'alice', 'pulse-node-2', 'conn_laptop', expireAt, now);

      // Disconnect mobile
      const res1 = await executeRemovePresence(redis, 'alice', 'pulse-node-1', 'conn_mobile', now);
      // Returns 0 (user is still online on laptop)
      expect(res1).toBe(0);

      const key = getPresenceUserKey('alice');
      const remaining = await redis.zrangebyscore(key, now, '+inf');
      expect(remaining).toEqual(['pulse-node-2:conn_laptop']);

      // Disconnect laptop (final connection)
      const res2 = await executeRemovePresence(redis, 'alice', 'pulse-node-2', 'conn_laptop', now);
      // Returns 1 (user is now OFFLINE)
      expect(res2).toBe(1);

      const exists = await redis.exists(key);
      expect(exists).toBe(0);
    });

    test('prunes expired companion leases during removal', async () => {
      const t0 = 100000;

      // conn_1 expires at 150000
      await executeRegisterPresence(redis, 'carol', 'pulse-node-1', 'conn_1', 150000, t0);
      // conn_ghost expired at 120000
      await executeRegisterPresence(redis, 'carol', 'pulse-node-2', 'conn_ghost', 120000, t0);

      // At t = 130000, conn_ghost has expired. We explicitly remove conn_1.
      const removeRes = await executeRemovePresence(redis, 'carol', 'pulse-node-1', 'conn_1', 130000);

      // Both conn_1 (explicitly removed) and conn_ghost (pruned) are gone -> count is 0 -> returns 1
      expect(removeRes).toBe(1);

      const key = getPresenceUserKey('carol');
      const exists = await redis.exists(key);
      expect(exists).toBe(0);
    });
  });

  describe('GET_ROOM_PRESENCE_ROSTER_LUA Atomic Snapshot', () => {
    test('returns only members with active unexpired leases and prunes dead members', async () => {
      const now = Date.now();
      const roomKey = getRoomMembersKey('general');

      // Room members set in Redis: alice, bob, charlie
      await redis.sadd(roomKey, 'alice', 'bob', 'charlie');

      // Alice is online with unexpired lease
      await executeRegisterPresence(redis, 'alice', 'node-1', 'conn_a', now + 60000, now);

      // Bob is online with unexpired lease
      await executeRegisterPresence(redis, 'bob', 'node-2', 'conn_b', now + 60000, now);

      // Charlie had a lease that expired 10 seconds ago
      await executeRegisterPresence(redis, 'charlie', 'node-1', 'conn_c', now - 10000, now - 50000);

      // Query roster
      const onlineRoster = await executeGetRoomPresenceRoster(redis, 'general', now);

      expect(onlineRoster.sort()).toEqual(['alice', 'bob'].sort());

      // Charlie should have been pruned from room membership set as well
      const remainingRoomMembers = await redis.smembers(roomKey);
      expect(remainingRoomMembers.sort()).toEqual(['alice', 'bob'].sort());
    });

    test('returns empty array when room has no active members', async () => {
      const roster = await executeGetRoomPresenceRoster(redis, 'empty-room', Date.now());
      expect(roster).toEqual([]);
    });
  });
});
