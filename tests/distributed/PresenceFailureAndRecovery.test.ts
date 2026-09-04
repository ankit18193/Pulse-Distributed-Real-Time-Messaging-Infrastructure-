import WebSocket from 'ws';
import http from 'http';
import RedisMock from 'ioredis-mock';
import { PulseServer } from '../../src/core/PulseServer.js';
import { PresenceManager } from '../../src/redis/PresenceManager.js';
import { RedisPubSubManager } from '../../src/redis/RedisPubSubManager.js';
import { RedisConnectionManager } from '../../src/redis/RedisConnectionManager.js';
import { PulseConfig, PulseEventEnvelope } from '../../src/types/index.js';
import { getPresenceUserKey, getRoomMembersKey } from '../../src/redis/PresenceLuaScripts.js';

describe('Distributed Presence Failure & Recovery E2E', () => {
  jest.setTimeout(15000);
  let redisShared: any;

  beforeEach(() => {
    redisShared = new (RedisMock as any)();
  });

  afterEach(async () => {
    await redisShared.flushall();
    jest.restoreAllMocks();
  });

  const getNextPort = (() => {
    let current = 9600 + Math.floor(Math.random() * 300);
    return () => current++;
  })();

  const createServerNode = async (
    instanceId: string,
    port: number
  ): Promise<{
    server: PulseServer;
    pubSub: RedisPubSubManager;
    presence: PresenceManager;
    port: number;
    redisMockInstance: any;
  }> => {
    const connMgr = new RedisConnectionManager(
      {
        host: '127.0.0.1',
        port: 6379,
        customClientFactory: () => new (RedisMock as any)()
      },
      instanceId
    );

    const pubSub = new RedisPubSubManager(connMgr, instanceId);
    const presence = new PresenceManager(redisShared, instanceId, {
      presenceTtlMs: 2000, // short lease for testing
      presenceFlushIntervalMs: 500,
      pubSubManager: pubSub
    });

    const config: PulseConfig = {
      port,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId,
      heartbeatIntervalMs: 5000,
      heartbeatTimeoutMs: 2000,
      maxPayloadBytes: 1024 * 1024,
      authSecret: 'presence-failure-recovery-secret-999999',
      redisEnabled: true
    };

    const server = new PulseServer(config, {}, {
      redisPubSubManager: pubSub,
      presenceManager: presence
    });

    await server.start();
    await pubSub.subscribePresence();

    return { server, pubSub, presence, port, redisMockInstance: redisShared };
  };

  const connectClient = (
    port: number,
    secret: string,
    userId: string
  ): Promise<{ ws: WebSocket; messages: PulseEventEnvelope[] }> => {
    return new Promise((resolve, reject) => {
      const serverInstance = new PulseServer({
        port,
        host: '127.0.0.1',
        nodeEnv: 'test',
        instanceId: 'auth-helper',
        heartbeatIntervalMs: 5000,
        heartbeatTimeoutMs: 2000,
        maxPayloadBytes: 1024,
        authSecret: secret
      });
      const token = serverInstance.getAuthenticator().generateToken({ userId });
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
      const messages: PulseEventEnvelope[] = [];

      ws.on('message', (data) => {
        try {
          messages.push(JSON.parse(data.toString()));
        } catch {
          // ignore
        }
      });

      ws.on('open', () => resolve({ ws, messages }));
      ws.on('error', reject);
    });
  };

  const getHealth = (port: number): Promise<{ statusCode: number; body: any }> => {
    return new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/healthz`, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          resolve({ statusCode: res.statusCode || 0, body: JSON.parse(data) });
        });
      }).on('error', reject);
    });
  };

  it('proves fail-open local operation during Redis outage and recovery upon reconnect', async () => {
    const portA = getNextPort();
    const nodeA = await createServerNode('node-failopen', portA);

    try {
      // Connect Alice locally to Node A
      const alice = await connectClient(portA, 'presence-failure-recovery-secret-999999', 'alice');
      await new Promise((r) => setTimeout(r, 50));
      expect(nodeA.server.getActiveConnectionCount()).toBe(1);

      // Verify healthy state
      let health = await getHealth(portA);
      expect(health.statusCode).toBe(200);
      expect(health.body.status).toBe('OK');
      expect(health.body.presence.mode).toBe('distributed');

      // Simulate Redis Outage
      jest.spyOn(nodeA.pubSub, 'isConnected').mockReturnValue(false);

      // Verify health degrades to DEGRADED without crashing (HTTP 200)
      health = await getHealth(portA);
      expect(health.statusCode).toBe(200);
      expect(health.body.status).toBe('DEGRADED');
      expect(health.body.presence.mode).toBe('degraded-local-only');

      // Local WebSocket connection continues uninterrupted
      expect(nodeA.server.getActiveConnectionCount()).toBe(1);

      // Connect Bob locally during Redis outage
      const bob = await connectClient(portA, 'presence-failure-recovery-secret-999999', 'bob');
      await new Promise((r) => setTimeout(r, 50));
      expect(nodeA.server.getActiveConnectionCount()).toBe(2);

      // Simulate Redis Recovery
      (nodeA.pubSub.isConnected as jest.Mock).mockReturnValue(true);

      health = await getHealth(portA);
      expect(health.statusCode).toBe(200);
      expect(health.body.status).toBe('OK');
      expect(health.body.presence.mode).toBe('distributed');

      alice.ws.close();
      bob.ws.close();
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      await nodeA.server.stop({ gracePeriodMs: 50 });
    }
  });

  it('prunes expired leases after node crash and maintains cluster room roster accuracy', async () => {
    const portA = getNextPort();
    const nodeA = await createServerNode('node-crash-test', portA);

    try {
      const roomKey = getRoomMembersKey('alpha');

      // Simulate Node B having registered a lease that subsequently expired (e.g. node killed with SIGKILL)
      const pastTime = Date.now() - 5000;
      const userKeyCrashed = getPresenceUserKey('crashed-user');
      await redisShared.zadd(userKeyCrashed, pastTime, 'node-dead:conn-dead-1');
      await redisShared.sadd(roomKey, 'crashed-user');

      // Also add an active user Alice on Node A
      const alice = await connectClient(portA, 'presence-failure-recovery-secret-999999', 'alice');
      await new Promise((r) => setTimeout(r, 50));

      await nodeA.server.getMessageDispatcher().dispatchRawMessage(
        nodeA.server.getConnectionManager().getConnectionsByUserId('alice')[0],
        JSON.stringify({
          type: 'ROOM_JOIN',
          target: { roomId: 'alpha' }
        })
      );

      // Fetch cluster room roster snapshot on Node A
      const roster = await nodeA.presence.getRoomRoster('alpha');

      // crashed-user was expired and must be pruned; only alice is returned
      expect(roster.roomId).toBe('alpha');
      expect(roster.members).toEqual(['alice']);
      expect(roster.totalOnline).toBe(1);

      // Stale member was removed from Redis SET
      const remaining = await redisShared.smembers(roomKey);
      expect(remaining).toEqual(['alice']);

      alice.ws.close();
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      await nodeA.server.stop({ gracePeriodMs: 50 });
    }
  });

  it('aggregates multi-device presence across cluster nodes and rejects stale events', async () => {
    const portA = getNextPort();
    const portB = getNextPort();
    const nodeA = await createServerNode('node-cluster-a', portA);
    const nodeB = await createServerNode('node-cluster-b', portB);

    try {
      // Connect Alice Device 1 on Node A
      const aliceDevice1 = await connectClient(portA, 'presence-failure-recovery-secret-999999', 'alice');
      await new Promise((r) => setTimeout(r, 50));

      // Connect Alice Device 2 on Node B
      const aliceDevice2 = await connectClient(portB, 'presence-failure-recovery-secret-999999', 'alice');
      await new Promise((r) => setTimeout(r, 50));

      // Both leases exist in Redis for Alice
      const userKey = getPresenceUserKey('alice');
      let leases = await redisShared.zrangebyscore(userKey, '-inf', '+inf');
      expect(leases.length).toBe(2);

      // Disconnect Device 1 on Node A
      aliceDevice1.ws.close();
      await new Promise((r) => setTimeout(r, 50));

      // Alice is still ONLINE because Device 2 on Node B remains active
      leases = await redisShared.zrangebyscore(userKey, '-inf', '+inf');
      expect(leases.length).toBe(1);
      const isAliceOnline = await nodeB.presence.isUserOnline('alice');
      expect(isAliceOnline).toBe(true);

      // Test stale event rejection
      const now = Date.now();
      nodeA.presence.recordPresenceEvent('alice', now);

      // Inbound event with timestamp in past or equal must be dropped
      expect(nodeA.presence.isStalePresenceEvent('alice', now - 1000)).toBe(true);
      expect(nodeA.presence.isStalePresenceEvent('alice', now)).toBe(true);
      expect(nodeA.presence.isStalePresenceEvent('alice', now + 1000)).toBe(false);

      // Disconnect Device 2 on Node B (final disconnect -> 1 to 0)
      aliceDevice2.ws.close();
      await new Promise((r) => setTimeout(r, 50));

      leases = await redisShared.zrangebyscore(userKey, '-inf', '+inf');
      expect(leases.length).toBe(0);
      const isAliceOnlineFinal = await nodeB.presence.isUserOnline('alice');
      expect(isAliceOnlineFinal).toBe(false);
    } finally {
      await nodeA.server.stop({ gracePeriodMs: 50 });
      await nodeB.server.stop({ gracePeriodMs: 50 });
    }
  });
});
