import { PresenceManager } from '../../src/redis/PresenceManager.js';
import RedisMock from 'ioredis-mock';

describe('PresenceManager Multi-Device & Lifecycle Aggregation', () => {
  let redis: any;
  let managerNode1: PresenceManager;
  let managerNode2: PresenceManager;

  beforeEach(() => {
    redis = new RedisMock();
    managerNode1 = new PresenceManager(redis, 'pulse-node-1', { presenceTtlMs: 60000 });
    managerNode2 = new PresenceManager(redis, 'pulse-node-2', { presenceTtlMs: 60000 });
  });

  afterEach(async () => {
    await redis.flushall();
  });

  describe('Single User / Single Connection Lifecycle', () => {
    test('registers connection, marks online, and marks offline on disconnect', async () => {
      // 1. Initial state: offline
      expect(await managerNode1.isUserOnline('alice')).toBe(false);
      expect(await managerNode1.getUserConnectionCount('alice')).toBe(0);

      // 2. Connect
      const reg = await managerNode1.registerConnection('alice', 'conn_1');
      expect(reg.isOnlineTransition).toBe(true);
      expect(reg.activeConnections).toBe(1);
      expect(await managerNode1.isUserOnline('alice')).toBe(true);
      expect(await managerNode1.getUserConnectionCount('alice')).toBe(1);

      // 3. Disconnect
      const rem = await managerNode1.removeConnection('alice', 'conn_1');
      expect(rem.isOfflineTransition).toBe(true);
      expect(rem.activeConnections).toBe(0);
      expect(await managerNode1.isUserOnline('alice')).toBe(false);
    });
  });

  describe('Multi-Device on Same Instance', () => {
    test('maintains ONLINE status across partial disconnects and triggers OFFLINE only on final disconnect', async () => {
      // Tab 1 connects (0 -> 1)
      const r1 = await managerNode1.registerConnection('alice', 'conn_tab1');
      expect(r1.isOnlineTransition).toBe(true);
      expect(r1.activeConnections).toBe(1);

      // Tab 2 connects (1 -> 2)
      const r2 = await managerNode1.registerConnection('alice', 'conn_tab2');
      expect(r2.isOnlineTransition).toBe(false);
      expect(r2.activeConnections).toBe(2);

      // Mobile app connects (2 -> 3)
      const r3 = await managerNode1.registerConnection('alice', 'conn_mobile');
      expect(r3.isOnlineTransition).toBe(false);
      expect(r3.activeConnections).toBe(3);

      // Tab 1 closes (3 -> 2)
      const d1 = await managerNode1.removeConnection('alice', 'conn_tab1');
      expect(d1.isOfflineTransition).toBe(false);
      expect(d1.activeConnections).toBe(2);
      expect(await managerNode1.isUserOnline('alice')).toBe(true);

      // Tab 2 closes (2 -> 1)
      const d2 = await managerNode1.removeConnection('alice', 'conn_tab2');
      expect(d2.isOfflineTransition).toBe(false);
      expect(d2.activeConnections).toBe(1);
      expect(await managerNode1.isUserOnline('alice')).toBe(true);

      // Mobile app closes (1 -> 0, final connection)
      const d3 = await managerNode1.removeConnection('alice', 'conn_mobile');
      expect(d3.isOfflineTransition).toBe(true);
      expect(d3.activeConnections).toBe(0);
      expect(await managerNode1.isUserOnline('alice')).toBe(false);
    });
  });

  describe('Multi-Device Across Multiple Pulse Instances', () => {
    test('aggregates connections across nodes and reports correct active list', async () => {
      // Node 1: Bob connects on desktop
      const r1 = await managerNode1.registerConnection('bob', 'conn_desktop');
      expect(r1.isOnlineTransition).toBe(true);
      expect(r1.activeConnections).toBe(1);

      // Node 2: Bob connects on mobile
      const r2 = await managerNode2.registerConnection('bob', 'conn_phone');
      expect(r2.isOnlineTransition).toBe(false);
      expect(r2.activeConnections).toBe(2);

      // Both instances see 2 active connections for Bob
      expect(await managerNode1.getUserConnectionCount('bob')).toBe(2);
      expect(await managerNode2.getUserConnectionCount('bob')).toBe(2);

      const leases = await managerNode1.getUserConnections('bob');
      expect(leases).toHaveLength(2);
      expect(leases).toEqual(
        expect.arrayContaining([
          { instanceId: 'pulse-node-1', connectionId: 'conn_desktop' },
          { instanceId: 'pulse-node-2', connectionId: 'conn_phone' }
        ])
      );

      // Node 1: Desktop closes
      const d1 = await managerNode1.removeConnection('bob', 'conn_desktop');
      expect(d1.isOfflineTransition).toBe(false);
      expect(d1.activeConnections).toBe(1);
      expect(await managerNode2.isUserOnline('bob')).toBe(true);

      // Node 2: Phone closes
      const d2 = await managerNode2.removeConnection('bob', 'conn_phone');
      expect(d2.isOfflineTransition).toBe(true);
      expect(d2.activeConnections).toBe(0);
      expect(await managerNode1.isUserOnline('bob')).toBe(false);
      expect(await managerNode2.isUserOnline('bob')).toBe(false);
    });
  });

  describe('Passive Lease Expiration & Node Crash Simulation', () => {
    test('automatically expires leases when node crashes without clean disconnect', async () => {
      const t0 = 100000;
      const shortTtl = 5000; // 5s lease

      // Node 1 registers Carol with custom expiration at t = 105000
      await managerNode1.registerConnection('carol', 'conn_crash', t0 + shortTtl, t0);
      expect(await managerNode1.isUserOnline('carol', t0)).toBe(true);
      expect(await managerNode2.getUserConnectionCount('carol', t0)).toBe(1);

      // Node 1 crashes! It never calls removeConnection.
      // Advance simulated time past expiration to t = 106000
      const tAfterCrash = 106000;

      // Querying Node 2 discovers lease expired and returns offline
      expect(await managerNode2.isUserOnline('carol', tAfterCrash)).toBe(false);
      expect(await managerNode2.getUserConnectionCount('carol', tAfterCrash)).toBe(0);
      expect(await managerNode2.getUserConnections('carol', tAfterCrash)).toEqual([]);

      // When Carol reconnects after crash, it correctly detects 0 -> 1 ONLINE transition
      const reconnected = await managerNode2.registerConnection(
        'carol',
        'conn_new',
        tAfterCrash + 60000,
        tAfterCrash
      );
      expect(reconnected.isOnlineTransition).toBe(true);
      expect(reconnected.activeConnections).toBe(1);
    });

    test('prunes companion expired leases while preserving active ones', async () => {
      const now = 200000;

      // Active lease expiring in future
      await managerNode1.registerConnection('dave', 'conn_active', now + 50000, now);

      // Expired ghost lease
      await managerNode2.registerConnection('dave', 'conn_ghost', now - 10000, now - 50000);

      const count = await managerNode1.getUserConnectionCount('dave', now);
      expect(count).toBe(1);

      const leases = await managerNode1.getUserConnections('dave', now);
      expect(leases).toEqual([{ instanceId: 'pulse-node-1', connectionId: 'conn_active' }]);
    });
  });

  describe('Input Validation & Error Resilience', () => {
    test('throws on missing userId or connectionId', async () => {
      await expect(managerNode1.registerConnection('', 'c1')).rejects.toThrow('required');
      await expect(managerNode1.registerConnection('u1', '')).rejects.toThrow('required');
      await expect(managerNode1.removeConnection('', 'c1')).rejects.toThrow('required');
      await expect(managerNode1.removeConnection('u1', '')).rejects.toThrow('required');
    });

    test('handles Redis failure gracefully by returning safe fallbacks', async () => {
      const brokenRedis: any = {
        eval: jest.fn().mockRejectedValue(new Error('Redis connection lost')),
        zremrangebyscore: jest.fn().mockRejectedValue(new Error('Redis connection lost')),
        zcard: jest.fn().mockRejectedValue(new Error('Redis connection lost'))
      };

      const failingManager = new PresenceManager(brokenRedis, 'pulse-node-failing');

      const reg = await failingManager.registerConnection('alice', 'c1');
      expect(reg.isOnlineTransition).toBe(false);
      expect(reg.activeConnections).toBe(0);

      const rem = await failingManager.removeConnection('alice', 'c1');
      expect(rem.isOfflineTransition).toBe(false);
      expect(rem.activeConnections).toBe(0);

      const count = await failingManager.getUserConnectionCount('alice');
      expect(count).toBe(0);
      expect(await failingManager.isUserOnline('alice')).toBe(false);
    });
  });
});
