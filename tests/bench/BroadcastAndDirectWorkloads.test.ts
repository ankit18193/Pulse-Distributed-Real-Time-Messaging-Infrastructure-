/**
 * Pulse — Distributed Real-Time Messaging Infrastructure
 * Checkpoint 15: Room Broadcast & Direct Messaging Workloads Tests
 */

import { PulseServer } from '../../src/core/PulseServer.js';
import { BroadcastProfile } from '../../src/bench/profiles/BroadcastProfile.js';
import { DirectProfile } from '../../src/bench/profiles/DirectProfile.js';
import { StatsAggregator } from '../../src/bench/StatsAggregator.js';
import { BenchmarkConfig } from '../../src/bench/types.js';

describe('Checkpoint 15: Broadcast and Direct Messaging Workloads', () => {
  const TEST_PORT = 9482;
  const AUTH_SECRET = 'bench-workload-secret';
  let server: PulseServer;

  beforeAll(async () => {
    server = new PulseServer({
      port: TEST_PORT,
      host: '127.0.0.1',
      authSecret: AUTH_SECRET,
      redisEnabled: false
    });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  describe('BroadcastProfile: Room Traffic & Fan-Out', () => {
    it('creates rooms, broadcasts messages, measures fan-out latency, and reports delivery', async () => {
      const config: BenchmarkConfig = {
        target: `ws://127.0.0.1:${TEST_PORT}`,
        profile: 'broadcast',
        connections: 6, // 3 clients per room across 2 rooms
        rooms: 2,
        durationSec: 1,
        messageRate: 10,
        rampRate: 50,
        authSecret: AUTH_SECRET,
        json: false,
        forceHighConcurrency: false
      };

      const aggregator = new StatsAggregator(config);
      const profile = new BroadcastProfile(config, aggregator);

      await profile.execute();
      aggregator.finish();

      expect(profile.getClientCount()).toBe(6);

      const result = aggregator.computeResult();
      expect(result.connectionsAttempted).toBe(6);
      expect(result.connectionsEstablished).toBe(6);
      expect(result.messagesSent).toBeGreaterThan(0);
      expect(result.messagesReceived).toBeGreaterThan(0);

      // Verify fan-out: messages received should be at least as high as messages sent (since 2 other members per room)
      expect(result.messagesReceived).toBeGreaterThanOrEqual(result.messagesSent);

      // Latency should be measured and valid
      expect(result.latency.count).toBeGreaterThan(0);
      expect(result.latency.minMs).toBeGreaterThanOrEqual(0);
      expect(result.latency.p50Ms).toBeGreaterThan(0);

      profile.cleanup();
      expect(profile.getClientCount()).toBe(0);
    });
  });

  describe('DirectProfile: Unicast Messaging & Delivery ACKs', () => {
    it('generates unicast messages, records delivery ACKs, and measures end-to-end latency', async () => {
      const config: BenchmarkConfig = {
        target: `ws://127.0.0.1:${TEST_PORT}`,
        profile: 'direct',
        connections: 4, // 2 sender-receiver pairs
        rooms: 1,
        durationSec: 1,
        messageRate: 10,
        rampRate: 50,
        authSecret: AUTH_SECRET,
        json: false,
        forceHighConcurrency: false
      };

      const aggregator = new StatsAggregator(config);
      const profile = new DirectProfile(config, aggregator);

      await profile.execute();
      aggregator.finish();

      expect(profile.getClientCount()).toBe(4);

      const result = aggregator.computeResult();
      expect(result.connectionsAttempted).toBe(4);
      expect(result.connectionsEstablished).toBe(4);
      expect(result.messagesSent).toBeGreaterThan(0);
      expect(result.messagesReceived).toBeGreaterThan(0);
      expect(profile.getAckCount()).toBeGreaterThan(0);

      // Latency should be measured and valid
      expect(result.latency.count).toBeGreaterThan(0);
      expect(result.latency.p50Ms).toBeGreaterThan(0);

      profile.cleanup();
      expect(profile.getClientCount()).toBe(0);
    });
  });
});
