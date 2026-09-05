/**
 * Pulse — Distributed Real-Time Messaging Infrastructure
 * Checkpoint 16: Two-Node Distributed Workload Benchmark Tests
 */

import RedisMock from 'ioredis-mock';
import { PulseServer } from '../../src/core/PulseServer.js';
import { DistributedTwoNodeProfile } from '../../src/bench/profiles/DistributedTwoNodeProfile.js';
import { StatsAggregator } from '../../src/bench/StatsAggregator.js';
import { RedisPubSubManager } from '../../src/redis/RedisPubSubManager.js';
import { RedisConnectionManager } from '../../src/redis/RedisConnectionManager.js';
import { PulseConfig } from '../../src/types/index.js';

describe('Checkpoint 16: Two-Node Distributed Workload Benchmark', () => {
  const NODE1_PORT = 9483;
  const NODE2_PORT = 9484;
  const AUTH_SECRET = 'two-node-bench-secret-minimum-32-chars-long';

  let server1: PulseServer;
  let server2: PulseServer;

  let pubSub1: RedisPubSubManager;
  let pubSub2: RedisPubSubManager;

  const createTestConfig = (instanceId: string, port: number): PulseConfig => ({
    port,
    host: '127.0.0.1',
    nodeEnv: 'test',
    instanceId,
    authSecret: AUTH_SECRET,
    heartbeatIntervalMs: 30000,
    heartbeatTimeoutMs: 60000,
    maxPayloadBytes: 65536,
    idempotencyCapacity: 500,
    idempotencyTtlMs: 60000,
    redisEnabled: true
  });

  beforeAll(async () => {
    const conn1 = new RedisConnectionManager({
      customClientFactory: () => new RedisMock()
    }, 'node-1');
    pubSub1 = new RedisPubSubManager(conn1, 'node-1');
    await pubSub1.connect();

    const conn2 = new RedisConnectionManager({
      customClientFactory: () => new RedisMock()
    }, 'node-2');
    pubSub2 = new RedisPubSubManager(conn2, 'node-2');
    await pubSub2.connect();

    // Start Node 1
    server1 = new PulseServer(createTestConfig('node-1', NODE1_PORT), {}, { redisPubSubManager: pubSub1 });
    await server1.start();

    // Start Node 2
    server2 = new PulseServer(createTestConfig('node-2', NODE2_PORT), {}, { redisPubSubManager: pubSub2 });
    await server2.start();
  });

  afterAll(async () => {
    await server1.stop();
    await server2.stop();
    await pubSub1.disconnect();
    await pubSub2.disconnect();
  });

  it('generates cross-node room traffic, measures end-to-end and transit latency, and reports delivery', async () => {
    const config = {
      node1Target: `ws://127.0.0.1:${NODE1_PORT}`,
      node2Target: `ws://127.0.0.1:${NODE2_PORT}`,
      connectionsPerNode: 3, // 3 senders on Node 1, 3 receivers on Node 2
      durationSec: 1,
      messageRate: 10,
      rooms: 2,
      authSecret: AUTH_SECRET
    };

    const benchmarkConfig = {
      target: `ws://127.0.0.1:${NODE1_PORT}`,
      profile: 'broadcast' as const,
      connections: 6,
      durationSec: 1,
      rampRate: 50,
      messageRate: 10,
      rooms: 2,
      authSecret: AUTH_SECRET,
      json: false,
      forceHighConcurrency: false
    };

    const aggregator = new StatsAggregator(benchmarkConfig);
    const profile = new DistributedTwoNodeProfile(config, aggregator);

    await profile.execute();
    aggregator.finish();

    expect(profile.getSenderCount()).toBe(3);
    expect(profile.getReceiverCount()).toBe(3);

    const result = aggregator.computeResult();
    expect(result.connectionsAttempted).toBe(6);
    expect(result.connectionsEstablished).toBe(6);
    expect(result.messagesSent).toBeGreaterThan(0);
    expect(result.messagesReceived).toBeGreaterThan(0);

    // Latency characterization
    expect(result.latency.count).toBeGreaterThan(0);
    expect(result.latency.p50Ms).toBeGreaterThan(0);

    // Cross-node transit latency characterization
    const transitStats = profile.getCrossNodeTransitStats();
    expect(transitStats.count).toBeGreaterThan(0);
    expect(transitStats.minMs).toBeGreaterThanOrEqual(0);

    profile.cleanup();
    expect(profile.getSenderCount()).toBe(0);
    expect(profile.getReceiverCount()).toBe(0);
  });
});
