import http from 'http';
import WebSocket from 'ws';
import RedisMock from 'ioredis-mock';
import { PulseServer } from '../../src/core/PulseServer.js';
import { PresenceManager } from '../../src/redis/PresenceManager.js';
import { RedisPubSubManager } from '../../src/redis/RedisPubSubManager.js';
import { RedisConnectionManager } from '../../src/redis/RedisConnectionManager.js';
import { PulseConfig, PulseEventEnvelope } from '../../src/types/index.js';
import { getPresenceUserKey } from '../../src/redis/PresenceLuaScripts.js';

describe('PulseServer Presence Lifecycle Integration', () => {
  let server: PulseServer;
  let testPort: number;
  let redisMock: any;
  let pubSubManager: RedisPubSubManager;
  let presenceManager: PresenceManager;
  let config: PulseConfig;

  beforeEach(async () => {
    testPort = 9200 + Math.floor(Math.random() * 700);
    redisMock = new (RedisMock as any)();

    const connectionManager = new RedisConnectionManager(
      {
        host: '127.0.0.1',
        port: 6379,
        customClientFactory: () => new (RedisMock as any)()
      },
      'pulse-node-lifecycle'
    );

    pubSubManager = new RedisPubSubManager(connectionManager, 'pulse-node-lifecycle');
    presenceManager = new PresenceManager(redisMock, 'pulse-node-lifecycle', {
      presenceTtlMs: 60000,
      presenceFlushIntervalMs: 15000,
      pubSubManager
    });

    config = {
      port: testPort,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'pulse-node-lifecycle',
      heartbeatIntervalMs: 5000,
      heartbeatTimeoutMs: 2000,
      maxPayloadBytes: 1024 * 1024,
      authSecret: 'test-presence-lifecycle-secret-1234567890',
      redisEnabled: true
    };

    server = new PulseServer(
      config,
      {},
      {
        redisPubSubManager: pubSubManager,
        presenceManager
      }
    );

    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await redisMock.flushall();
    jest.restoreAllMocks();
  });

  const connectClient = (token: string): Promise<{ ws: WebSocket; messages: PulseEventEnvelope[] }> => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${token}`);
      const messages: PulseEventEnvelope[] = [];

      ws.on('message', (data) => {
        try {
          messages.push(JSON.parse(data.toString()));
        } catch {
          // ignore
        }
      });

      ws.on('open', () => {
        resolve({ ws, messages });
      });

      ws.on('error', (err) => {
        reject(err);
      });
    });
  };

  it('wires PresenceManager into PulseServer and exposes it via getter', () => {
    expect(server.getPresenceManager()).toBe(presenceManager);
  });

  it('does NOT register presence lease for connections that fail authentication', async () => {
    const invalidToken = 'invalid.jwt.token';

    await expect(connectClient(invalidToken)).rejects.toThrow();

    // Verify no presence lease exists in Redis
    const userKeys = await redisMock.keys('pulse:presence:user:*');
    expect(userKeys).toEqual([]);
  });

  it('registers presence lease upon successful authentication and connection establishment', async () => {
    const token = server.getAuthenticator().generateToken({ userId: 'alice' });
    const { ws, messages } = await connectClient(token);

    // Wait briefly for connection established & presence registration
    await new Promise((r) => setTimeout(r, 50));

    expect(server.getActiveConnectionCount()).toBe(1);
    const userKey = getPresenceUserKey('alice');
    const leases = await redisMock.zrangebyscore(userKey, '-inf', '+inf');
    expect(leases.length).toBe(1);
    expect(leases[0]).toMatch(/^pulse-node-lifecycle:/);

    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('tracks multiple devices independently and transitions OFFLINE only when last device disconnects', async () => {
    const token = server.getAuthenticator().generateToken({ userId: 'bob' });

    // Device 1 connects
    const device1 = await connectClient(token);
    await new Promise((r) => setTimeout(r, 50));

    const userKey = getPresenceUserKey('bob');
    let leases = await redisMock.zrangebyscore(userKey, '-inf', '+inf');
    expect(leases.length).toBe(1);

    // Device 2 connects
    const device2 = await connectClient(token);
    await new Promise((r) => setTimeout(r, 50));

    leases = await redisMock.zrangebyscore(userKey, '-inf', '+inf');
    expect(leases.length).toBe(2);

    // Device 1 disconnects (2 -> 1)
    device1.ws.close();
    await new Promise((r) => setTimeout(r, 50));

    leases = await redisMock.zrangebyscore(userKey, '-inf', '+inf');
    expect(leases.length).toBe(1);

    // Device 2 disconnects (1 -> 0)
    device2.ws.close();
    await new Promise((r) => setTimeout(r, 50));

    leases = await redisMock.zrangebyscore(userKey, '-inf', '+inf');
    expect(leases.length).toBe(0);
  });

  it('ensures terminated connections are excluded from the lease renewal loop', async () => {
    const token = server.getAuthenticator().generateToken({ userId: 'charlie' });
    const { ws } = await connectClient(token);
    await new Promise((r) => setTimeout(r, 50));

    expect(server.getActiveConnectionCount()).toBe(1);

    // Close connection
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(server.getActiveConnectionCount()).toBe(0);

    // Trigger renewal flush
    const renewed = await presenceManager.flushLeaseRenewals();
    expect(renewed).toBe(0);

    const userKey = getPresenceUserKey('charlie');
    const leases = await redisMock.zrangebyscore(userKey, '-inf', '+inf');
    expect(leases.length).toBe(0);
  });

  it('stops renewal loop cleanly on server shutdown', async () => {
    expect(presenceManager.isRenewalLoopRunning()).toBe(true);

    await server.stop();

    expect(presenceManager.isRenewalLoopRunning()).toBe(false);
  });
});
