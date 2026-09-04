import RedisMock from 'ioredis-mock';
import { PresenceManager } from '../../src/redis/PresenceManager.js';
import { MessageDispatcher } from '../../src/core/MessageDispatcher.js';
import { ConnectionManager } from '../../src/core/ConnectionManager.js';
import { RoomManager } from '../../src/core/RoomManager.js';
import { Connection } from '../../src/core/Connection.js';
import { getRoomMembersKey } from '../../src/redis/PresenceLuaScripts.js';

describe('Cluster Room Presence Snapshots & Rosters', () => {
  let redis: any;
  let presenceManager: PresenceManager;
  let connectionManager: ConnectionManager;
  let roomManager: RoomManager;
  let dispatcher: MessageDispatcher;

  const createMockSocket = () => ({
    readyState: 1, // OPEN
    bufferedAmount: 0,
    send: jest.fn(),
    close: jest.fn()
  });

  beforeEach(() => {
    redis = new (RedisMock as any)();
    presenceManager = new PresenceManager(redis, 'node-1', {
      presenceTtlMs: 60000,
      keySafeguardTtlSec: 120
    });

    connectionManager = new ConnectionManager();
    roomManager = new RoomManager();
    dispatcher = new MessageDispatcher({
      connectionManager,
      roomManager,
      presenceManager,
      instanceId: 'node-1'
    });
  });

  afterEach(async () => {
    presenceManager.stopRenewalLoop();
    await redis.flushall();
    jest.restoreAllMocks();
  });

  describe('Redis Room Membership Data Model', () => {
    it('tracks user IDs in Redis SET and deduplicates multi-device members', async () => {
      const roomKey = getRoomMembersKey('dev');

      // User Alice joins with Device 1
      await presenceManager.addRoomMember('dev', 'alice');
      let members = await redis.smembers(roomKey);
      expect(members).toEqual(['alice']);

      // User Alice joins with Device 2
      await presenceManager.addRoomMember('dev', 'alice');
      members = await redis.smembers(roomKey);
      expect(members).toEqual(['alice']); // Set deduplication

      // User Bob joins
      await presenceManager.addRoomMember('dev', 'bob');
      members = await redis.smembers(roomKey);
      expect(members.sort()).toEqual(['alice', 'bob']);

      // Remove Bob
      await presenceManager.removeRoomMember('dev', 'bob');
      members = await redis.smembers(roomKey);
      expect(members).toEqual(['alice']);
    });
  });

  describe('Online-Only Roster & Stale Member Pruning', () => {
    it('returns only users with active connection leases and prunes stale offline users', async () => {
      const roomKey = getRoomMembersKey('general');

      // Add 3 users to room general
      await presenceManager.addRoomMember('general', 'alice');
      await presenceManager.addRoomMember('general', 'bob');
      await presenceManager.addRoomMember('general', 'charlie');

      // Register active presence lease for Alice only
      await presenceManager.registerConnection('alice', 'conn-a-1');

      // Register expired presence lease for Bob (expired in the past)
      const now = Date.now();
      const userKeyBob = 'pulse:presence:user:bob';
      await redis.zadd(userKeyBob, now - 5000, 'node-1:conn-b-1');

      // Charlie has zero leases registered anywhere

      // Fetch room roster snapshot
      const roster = await presenceManager.getRoomRoster('general');

      // Only Alice is currently online
      expect(roster.roomId).toBe('general');
      expect(roster.members).toEqual(['alice']);
      expect(roster.totalOnline).toBe(1);

      // Verify that Bob and Charlie were pruned from the Redis room members SET
      const remainingRedisMembers = await redis.smembers(roomKey);
      expect(remainingRedisMembers).toEqual(['alice']);
    });
  });

  describe('Multi-Device Safe Room Leave Behavior', () => {
    it('does not remove user from room membership when one device leaves but another remains', async () => {
      // Connect Alice on Device 1
      const conn1 = new Connection({
        connectionId: 'alice-device-1',
        socket: createMockSocket() as any,
        userId: 'alice'
      });
      connectionManager.addConnection(conn1);
      await presenceManager.registerConnection('alice', 'alice-device-1');

      // Connect Alice on Device 2
      const conn2 = new Connection({
        connectionId: 'alice-device-2',
        socket: createMockSocket() as any,
        userId: 'alice'
      });
      connectionManager.addConnection(conn2);
      await presenceManager.registerConnection('alice', 'alice-device-2');

      // Device 1 joins 'engineering'
      await dispatcher.dispatchRawMessage(
        conn1,
        JSON.stringify({
          type: 'ROOM_JOIN',
          target: { roomId: 'engineering' },
          correlationId: 'req-1'
        })
      );

      // Device 2 joins 'engineering'
      await dispatcher.dispatchRawMessage(
        conn2,
        JSON.stringify({
          type: 'ROOM_JOIN',
          target: { roomId: 'engineering' },
          correlationId: 'req-2'
        })
      );

      const roomKey = getRoomMembersKey('engineering');
      let members = await redis.smembers(roomKey);
      expect(members).toEqual(['alice']);

      // Device 1 leaves 'engineering'
      await dispatcher.dispatchRawMessage(
        conn1,
        JSON.stringify({
          type: 'ROOM_LEAVE',
          target: { roomId: 'engineering' },
          correlationId: 'req-3'
        })
      );

      // Because Device 2 is still in 'engineering', Alice MUST NOT be removed from Redis room set
      members = await redis.smembers(roomKey);
      expect(members).toEqual(['alice']);

      // Device 2 leaves 'engineering'
      await dispatcher.dispatchRawMessage(
        conn2,
        JSON.stringify({
          type: 'ROOM_LEAVE',
          target: { roomId: 'engineering' },
          correlationId: 'req-4'
        })
      );

      // Now that no devices remain in 'engineering', Alice is cleanly removed
      members = await redis.smembers(roomKey);
      expect(members).toEqual([]);
    });
  });

  describe('ROOM_JOIN Integration with Roster Information', () => {
    it('returns roster snapshot within ROOM_JOIN_ACK while preserving existing fields', async () => {
      // Alice is already connected and in room
      const aliceConn = new Connection({
        connectionId: 'conn-alice',
        socket: createMockSocket() as any,
        userId: 'alice'
      });
      connectionManager.addConnection(aliceConn);
      await presenceManager.registerConnection('alice', 'conn-alice');
      await dispatcher.dispatchRawMessage(
        aliceConn,
        JSON.stringify({
          type: 'ROOM_JOIN',
          target: { roomId: 'standup' }
        })
      );

      // Bob connects and joins 'standup'
      const bobSocket = createMockSocket();
      const bobConn = new Connection({
        connectionId: 'conn-bob',
        socket: bobSocket as any,
        userId: 'bob'
      });
      connectionManager.addConnection(bobConn);
      await presenceManager.registerConnection('bob', 'conn-bob');

      await dispatcher.dispatchRawMessage(
        bobConn,
        JSON.stringify({
          type: 'ROOM_JOIN',
          target: { roomId: 'standup' },
          correlationId: 'bob-join-req'
        })
      );

      // Bob receives ROOM_JOIN_ACK
      expect(bobSocket.send).toHaveBeenCalled();
      const sentPayload = JSON.parse(bobSocket.send.mock.calls[0][0]);

      expect(sentPayload.type).toBe('ROOM_JOIN_ACK');
      expect(sentPayload.correlationId).toBe('bob-join-req');
      expect(sentPayload.target).toEqual({ roomId: 'standup' });

      // Check backward compatibility: existing fields present
      expect(sentPayload.payload.roomId).toBe('standup');
      expect(sentPayload.payload.status).toBe('JOINED');
      expect(sentPayload.payload.memberCount).toBe(2);

      // Check roster presence fields
      expect(sentPayload.payload.members.sort()).toEqual(['alice', 'bob']);
      expect(sentPayload.payload.totalOnline).toBe(2);
      expect(sentPayload.payload.roster).toEqual({
        roomId: 'standup',
        members: ['alice', 'bob'],
        totalOnline: 2
      });
    });
  });

  describe('Fail-Open Behavior when Redis is Degraded', () => {
    it('falls back to local roster when Redis operation fails', async () => {
      const brokenRedis: any = {
        eval: jest.fn().mockRejectedValue(new Error('Redis cluster unreachable')),
        sadd: jest.fn().mockRejectedValue(new Error('Redis cluster unreachable')),
        srem: jest.fn().mockRejectedValue(new Error('Redis cluster unreachable'))
      };

      const fallbackPresenceManager = new PresenceManager(brokenRedis, 'node-degraded');
      dispatcher.setPresenceManager(fallbackPresenceManager);

      // Alice is connected locally in room 'support'
      const aliceConn = new Connection({
        connectionId: 'conn-alice-local',
        socket: createMockSocket() as any,
        userId: 'alice'
      });
      connectionManager.addConnection(aliceConn);
      roomManager.joinRoom('support', 'conn-alice-local');

      // Request roster under degraded state
      const roster = await fallbackPresenceManager.getRoomRoster('support');

      expect(roster.roomId).toBe('support');
      expect(roster.members).toEqual(['alice']);
      expect(roster.totalOnline).toBe(1);
    });
  });
});
