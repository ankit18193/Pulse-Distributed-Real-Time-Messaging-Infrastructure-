/**
 * Pulse — Distributed Real-Time Messaging Infrastructure
 * Checkpoint 17: Slow Consumer Backpressure & Presence Churn Benchmark Tests
 */

import RedisMock from 'ioredis-mock';
import { PulseServer } from '../../src/core/PulseServer.js';
import { BackpressureProfile } from '../../src/bench/profiles/BackpressureProfile.js';
import { PresenceChurnProfile } from '../../src/bench/profiles/PresenceChurnProfile.js';
import { BenchmarkRunner } from '../../src/bench/BenchmarkRunner.js';
import { StatsAggregator } from '../../src/bench/StatsAggregator.js';
import { RedisConnectionManager } from '../../src/redis/RedisConnectionManager.js';
import { RedisPubSubManager } from '../../src/redis/RedisPubSubManager.js';
import { PulseConfig } from '../../src/types/index.js';

describe('Checkpoint 17: Backpressure & Presence Churn Benchmarks', () => {
  const SERVER_PORT = 9485;
  const AUTH_SECRET = 'checkpoint-17-bench-secret-key-32chars';

  let server: PulseServer;
  let pubSub: RedisPubSubManager;

  const createServerConfig = (port: number, maxBufferedAmountBytes: number = 32768): PulseConfig => ({
    port,
    host: '127.0.0.1',
    nodeEnv: 'test',
    instanceId: 'bench-bp-node',
    authSecret: AUTH_SECRET,
    heartbeatIntervalMs: 30000,
    heartbeatTimeoutMs: 60000,
    maxPayloadBytes: 65536,
    maxBufferedAmountBytes,
    idempotencyCapacity: 500,
    idempotencyTtlMs: 60000,
    redisEnabled: true,
    presenceTtlMs: 5000,
    presenceFlushIntervalMs: 1000
  });

  beforeAll(async () => {
    const conn = new RedisConnectionManager({
      customClientFactory: () => new RedisMock()
    }, 'bench-bp-node');
    pubSub = new RedisPubSubManager(conn, 'bench-bp-node');
    await pubSub.connect();

    // Start server with 32KB max buffered amount to trigger backpressure deterministically
    server = new PulseServer(createServerConfig(SERVER_PORT, 32768), {}, { redisPubSubManager: pubSub });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    await pubSub.disconnect();
  });

  beforeEach(async () => {
    const start = Date.now();
    while (server.getConnectionManager().getCount() > 0 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 25));
    }
  });

  describe('Slow Consumer / Backpressure Benchmark', () => {
    it('detects slow consumer, enforces bufferedAmount protection with code 1008, while healthy consumer continues operating', async () => {
      const config = {
        target: `ws://127.0.0.1:${SERVER_PORT}`,
        profile: 'backpressure' as const,
        connections: 3,
        durationSec: 2,
        rampRate: 10,
        messageRate: 50,
        rooms: 1,
        authSecret: AUTH_SECRET,
        json: false,
        forceHighConcurrency: false
      };

      const aggregator = new StatsAggregator(config);
      const profile = new BackpressureProfile(config, aggregator);

      await profile.execute();
      aggregator.finish();

      // 1. Slow consumer must be terminated with policy violation code 1008
      expect(profile.isSlowConsumerEvicted()).toBe(true);
      expect(profile.getSlowConsumerCloseCode()).toBe(1008);

      // 2. Healthy consumer must remain active and have successfully received broadcast frames
      expect(profile.getHealthyReceivedCount()).toBeGreaterThan(0);
      expect(profile.isHealthyConsumerActive()).toBe(true);

      await profile.cleanup();
    });

    it('runs backpressure profile via BenchmarkRunner end-to-end', async () => {
      const runner = new BenchmarkRunner({
        target: `ws://127.0.0.1:${SERVER_PORT}`,
        profile: 'backpressure',
        connections: 3,
        durationSec: 1,
        authSecret: AUTH_SECRET
      });

      const result = await runner.run();
      expect(result.profile).toBe('backpressure');
      expect(result.connectionsAttempted).toBeGreaterThanOrEqual(3);
      expect(result.connectionsEstablished).toBeGreaterThanOrEqual(3);

      const start = Date.now();
      while (server.getConnectionManager().getCount() > 0 && Date.now() - start < 1500) {
        await new Promise((r) => setTimeout(r, 25));
      }
    });
  });

  describe('Presence Churn Benchmark', () => {
    it('executes repeated connect/disconnect churn cycles with multi-device users and clean resource recovery', async () => {
      const config = {
        target: `ws://127.0.0.1:${SERVER_PORT}`,
        profile: 'presence' as const,
        connections: 6,
        durationSec: 1,
        rampRate: 20,
        messageRate: 10,
        rooms: 1,
        authSecret: AUTH_SECRET,
        json: false,
        forceHighConcurrency: false
      };

      const aggregator = new StatsAggregator(config);
      const profile = new PresenceChurnProfile(config, aggregator);

      await profile.execute();
      aggregator.finish();

      const cycleStats = profile.getCycleStats();
      expect(cycleStats.length).toBeGreaterThanOrEqual(1);

      // Verify each round had balanced connect and disconnect counts
      for (const stat of cycleStats) {
        expect(stat.connectedCount).toBeGreaterThan(0);
        expect(stat.disconnectedCount).toBe(stat.connectedCount);
        expect(stat.durationMs).toBeGreaterThanOrEqual(0);
      }

      expect(profile.getTotalConnectedCycles()).toBeGreaterThan(0);
      expect(profile.getTotalDisconnectedCycles()).toBe(profile.getTotalConnectedCycles());

      // Wait for server to process final disconnects if any remain in flight
      const start = Date.now();
      while (server.getConnectionManager().getCount() > 0 && Date.now() - start < 1500) {
        await new Promise((r) => setTimeout(r, 25));
      }

      // Verify no leaked connections on server
      expect(server.getConnectionManager().getCount()).toBe(0);

      const result = aggregator.computeResult();
      expect(result.connectionsAttempted).toBe(profile.getTotalConnectedCycles());
      expect(result.connectionsEstablished).toBe(profile.getTotalConnectedCycles());
      expect(result.connectLatency.count).toBe(profile.getTotalConnectedCycles());
    });

    it('runs presence churn profile via BenchmarkRunner end-to-end', async () => {
      const runner = new BenchmarkRunner({
        target: `ws://127.0.0.1:${SERVER_PORT}`,
        profile: 'presence',
        connections: 4,
        durationSec: 1,
        authSecret: AUTH_SECRET
      });

      const result = await runner.run();
      expect(result.profile).toBe('presence');
      expect(result.connectionsAttempted).toBeGreaterThan(0);
      expect(result.connectionsEstablished).toBeGreaterThan(0);
    });
  });
});
