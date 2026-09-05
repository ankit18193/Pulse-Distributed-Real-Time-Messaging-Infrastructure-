/**
 * Pulse — Distributed Real-Time Messaging Infrastructure
 * Checkpoint 14: Connection Ramp & Saturation Benchmark Tests
 */

import { PulseServer } from '../../src/core/PulseServer.js';
import { RampProfile } from '../../src/bench/profiles/RampProfile.js';
import { StatsAggregator } from '../../src/bench/StatsAggregator.js';
import { BenchmarkConfig } from '../../src/bench/types.js';

describe('Checkpoint 14: Connection Ramp & Saturation Benchmark Profile', () => {
  const TEST_PORT = 9481;
  const AUTH_SECRET = 'bench-ramp-test-secret';
  let server: PulseServer;

  beforeAll(async () => {
    server = new PulseServer({
      port: TEST_PORT,
      host: '127.0.0.1',
      authSecret: AUTH_SECRET,
      redisEnabled: false,
      enableBackpressure: true
    });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('executes controlled connection ramp and measures handshake latencies against live Pulse server', async () => {
    const config: BenchmarkConfig = {
      target: `ws://127.0.0.1:${TEST_PORT}`,
      profile: 'ramp',
      connections: 15,
      durationSec: 1,
      rampRate: 50,
      messageRate: 10,
      rooms: 2,
      authSecret: AUTH_SECRET,
      json: false,
      forceHighConcurrency: false
    };

    const aggregator = new StatsAggregator(config);
    const profile = new RampProfile(config, aggregator);

    await profile.execute();
    aggregator.finish();

    expect(profile.getActiveSocketCount()).toBe(15);

    const result = aggregator.computeResult();
    expect(result.connectionsAttempted).toBe(15);
    expect(result.connectionsEstablished).toBe(15);
    expect(result.connectionsFailed).toBe(0);
    expect(result.connectLatency.count).toBe(15);
    expect(result.connectLatency.minMs).toBeGreaterThan(0);
    expect(result.connectLatency.p50Ms).toBeGreaterThan(0);
    expect(result.connectLatency.p95Ms).toBeGreaterThan(0);
    expect(result.passed).toBe(true);

    // Clean teardown
    profile.cleanup();
    expect(profile.getActiveSocketCount()).toBe(0);
  });

  it('records connection failures and reports failure metrics when target server is down', async () => {
    const unreachablePort = 59998;
    const config: BenchmarkConfig = {
      target: `ws://127.0.0.1:${unreachablePort}`,
      profile: 'ramp',
      connections: 4,
      durationSec: 1,
      rampRate: 100,
      messageRate: 10,
      rooms: 1,
      authSecret: AUTH_SECRET,
      json: false,
      forceHighConcurrency: false
    };

    const aggregator = new StatsAggregator(config);
    const profile = new RampProfile(config, aggregator);

    await profile.execute();
    aggregator.finish();

    const result = aggregator.computeResult();
    expect(result.connectionsAttempted).toBe(4);
    expect(result.connectionsEstablished).toBe(0);
    expect(result.connectionsFailed).toBe(4);
    expect(result.passed).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);

    profile.cleanup();
  });

  it('stops ramp immediately when abort() is invoked', async () => {
    const config: BenchmarkConfig = {
      target: `ws://127.0.0.1:${TEST_PORT}`,
      profile: 'ramp',
      connections: 50,
      durationSec: 5,
      rampRate: 5, // slow ramp: 5 per sec
      messageRate: 10,
      rooms: 1,
      authSecret: AUTH_SECRET,
      json: false,
      forceHighConcurrency: false
    };

    const aggregator = new StatsAggregator(config);
    const profile = new RampProfile(config, aggregator);

    // Start execution and abort after 150ms
    const runPromise = profile.execute();
    setTimeout(() => {
      profile.abort();
    }, 150);

    await runPromise;
    aggregator.finish();

    // Sockets established before abort should be closed by abort/cleanup
    expect(profile.getActiveSocketCount()).toBe(0);
  });
});
