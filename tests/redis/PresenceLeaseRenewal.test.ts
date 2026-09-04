import RedisMock from 'ioredis-mock';
import { PresenceManager } from '../../src/redis/PresenceManager.js';
import { getPresenceUserKey, formatPresenceMember } from '../../src/redis/PresenceLuaScripts.js';
import { Connection } from '../../src/core/Connection.js';

describe('Presence Lease Renewal Lifecycle', () => {
  let redis: any;
  let presenceManager: PresenceManager;
  const instanceId = 'pulse-node-renewal';
  const presenceTtlMs = 60000;
  const flushIntervalMs = 15000;

  beforeEach(() => {
    redis = new (RedisMock as any)();
    presenceManager = new PresenceManager(redis, instanceId, {
      presenceTtlMs,
      presenceFlushIntervalMs: flushIntervalMs
    });
  });

  afterEach(async () => {
    presenceManager.stopRenewalLoop();
    await redis.flushall();
    jest.restoreAllMocks();
  });

  it('starts and stops the renewal timer correctly', () => {
    expect(presenceManager.isRenewalLoopRunning()).toBe(false);

    presenceManager.startRenewalLoop();
    expect(presenceManager.isRenewalLoopRunning()).toBe(true);

    presenceManager.stopRenewalLoop();
    expect(presenceManager.isRenewalLoopRunning()).toBe(false);
  });

  it('renews active connection leases and moves expiration forward', async () => {
    const userId = 'alice';
    const connectionId = 'conn-alice-1';
    const t0 = 100000;

    // Register initial lease at t0
    await presenceManager.registerConnection(userId, connectionId, t0 + presenceTtlMs, t0);

    const userKey = getPresenceUserKey(userId);
    const member = formatPresenceMember(instanceId, connectionId);

    const initialScore = await redis.zscore(userKey, member);
    expect(Number(initialScore)).toBe(t0 + presenceTtlMs);

    // Flush renewal at t0 + 15000ms
    const t1 = t0 + 15000;
    const renewedCount = await presenceManager.flushLeaseRenewals(t1);
    expect(renewedCount).toBe(1);

    const renewedScore = await redis.zscore(userKey, member);
    expect(Number(renewedScore)).toBe(t1 + presenceTtlMs);
    expect(Number(renewedScore)).toBeGreaterThan(Number(initialScore));
  });

  it('renews multiple active connections across multiple users in a single pipeline', async () => {
    const t0 = 200000;

    await presenceManager.registerConnection('user-1', 'conn-1', t0 + presenceTtlMs, t0);
    await presenceManager.registerConnection('user-1', 'conn-2', t0 + presenceTtlMs, t0);
    await presenceManager.registerConnection('user-2', 'conn-3', t0 + presenceTtlMs, t0);

    expect(presenceManager.getLocalActiveConnectionCount()).toBe(3);

    const t1 = t0 + 20000;
    const renewedCount = await presenceManager.flushLeaseRenewals(t1);
    expect(renewedCount).toBe(3);

    const scoreU1C1 = await redis.zscore(getPresenceUserKey('user-1'), formatPresenceMember(instanceId, 'conn-1'));
    const scoreU1C2 = await redis.zscore(getPresenceUserKey('user-1'), formatPresenceMember(instanceId, 'conn-2'));
    const scoreU2C3 = await redis.zscore(getPresenceUserKey('user-2'), formatPresenceMember(instanceId, 'conn-3'));

    expect(Number(scoreU1C1)).toBe(t1 + presenceTtlMs);
    expect(Number(scoreU1C2)).toBe(t1 + presenceTtlMs);
    expect(Number(scoreU2C3)).toBe(t1 + presenceTtlMs);
  });

  it('excludes disconnected connections from subsequent lease renewals', async () => {
    const t0 = 300000;

    await presenceManager.registerConnection('user-bob', 'conn-bob-1', t0 + presenceTtlMs, t0);
    await presenceManager.registerConnection('user-bob', 'conn-bob-2', t0 + presenceTtlMs, t0);

    // Disconnect conn-bob-1
    await presenceManager.removeConnection('user-bob', 'conn-bob-1', t0 + 5000);

    expect(presenceManager.getLocalActiveConnectionCount()).toBe(1);

    const t1 = t0 + 15000;
    const renewedCount = await presenceManager.flushLeaseRenewals(t1);
    expect(renewedCount).toBe(1);

    const scoreBob2 = await redis.zscore(getPresenceUserKey('user-bob'), formatPresenceMember(instanceId, 'conn-bob-2'));
    expect(Number(scoreBob2)).toBe(t1 + presenceTtlMs);

    // conn-bob-1 should not exist in Redis ZSET
    const scoreBob1 = await redis.zscore(getPresenceUserKey('user-bob'), formatPresenceMember(instanceId, 'conn-bob-1'));
    expect(scoreBob1).toBeNull();
  });

  it('does not write to Redis when there are 0 active local connections', async () => {
    const pipelineSpy = jest.spyOn(redis, 'pipeline');

    const renewedCount = await presenceManager.flushLeaseRenewals(400000);
    expect(renewedCount).toBe(0);
    expect(pipelineSpy).not.toHaveBeenCalled();
  });

  it('supports custom activeConnectionProvider and cleanly shuts down renewal loop', async () => {
    let mockConnections = [
      { userId: 'charlie', connectionId: 'conn-c1' },
      { userId: 'charlie', connectionId: 'conn-c2' }
    ];

    presenceManager.startRenewalLoop(() => mockConnections);
    expect(presenceManager.isRenewalLoopRunning()).toBe(true);

    const renewedCount = await presenceManager.flushLeaseRenewals(500000);
    expect(renewedCount).toBe(2);

    // Remove one connection from provider
    mockConnections = [{ userId: 'charlie', connectionId: 'conn-c1' }];
    const renewedCount2 = await presenceManager.flushLeaseRenewals(515000);
    expect(renewedCount2).toBe(1);

    // Shutdown stops renewal
    presenceManager.stopRenewalLoop();
    expect(presenceManager.isRenewalLoopRunning()).toBe(false);
  });

  it('proves WebSocket heartbeat (ping/pong) is local and does NOT trigger Redis writes', () => {
    const mockSocket: any = {
      readyState: 1, // WebSocket.OPEN
      bufferedAmount: 0,
      send: jest.fn(),
      close: jest.fn()
    };

    const redisEvalSpy = jest.spyOn(redis, 'eval');
    const redisZaddSpy = jest.spyOn(redis, 'zadd');

    const connection = new Connection({
      connectionId: 'conn-hb-1',
      userId: 'user-heartbeat',
      socket: mockSocket
    });

    const initialTouch = connection.lastSeenAt;

    // Simulate multiple heartbeat pongs / touches
    connection.touch();
    expect(connection.lastSeenAt).toBeGreaterThanOrEqual(initialTouch);

    connection.touch();
    expect(connection.lastSeenAt).toBeGreaterThanOrEqual(initialTouch);

    // Verify Redis was NEVER invoked by heartbeat touch
    expect(redisEvalSpy).not.toHaveBeenCalled();
    expect(redisZaddSpy).not.toHaveBeenCalled();
  });
});
