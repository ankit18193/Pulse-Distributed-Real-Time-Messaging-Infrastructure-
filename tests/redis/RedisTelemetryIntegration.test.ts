import { RedisMetrics } from '../../src/redis/RedisMetrics.js';
import { RedisPubSubManager } from '../../src/redis/RedisPubSubManager.js';
import { RedisConnectionManager } from '../../src/redis/RedisConnectionManager.js';
import { PulseMetricsRegistry } from '../../src/metrics/PulseMetricsRegistry.js';
import { PrometheusSerializer } from '../../src/metrics/PrometheusSerializer.js';

describe('Checkpoint 10: Redis Telemetry & Metrics Registry Integration', () => {
  describe('Unit: RedisMetrics with PulseMetricsRegistry', () => {
    let registry: PulseMetricsRegistry;
    let metrics: RedisMetrics;

    beforeEach(() => {
      registry = new PulseMetricsRegistry();
      metrics = new RedisMetrics(registry);
    });

    it('tracks connection state as Prometheus gauge (1 = connected, 0 = disconnected)', () => {
      const stateGauge = registry.getGauge('pulse_redis_connection_state');
      expect(stateGauge).toBeDefined();

      metrics.setConnectionState('connected');
      expect(stateGauge?.get()).toBe(1);
      expect(metrics.getSnapshot()['redis.connection.state']).toBe('connected');

      metrics.setConnectionState('disconnected');
      expect(stateGauge?.get()).toBe(0);
      expect(metrics.getSnapshot()['redis.connection.state']).toBe('disconnected');
    });

    it('tracks in-flight publishes, publish count, errors, and latency histogram', () => {
      const inFlightGauge = registry.getGauge('pulse_redis_publish_in_flight');
      const publishCounter = registry.getCounter('pulse_redis_publish_total');
      const latencyHist = registry.getHistogram('pulse_redis_publish_duration_seconds');

      expect(inFlightGauge).toBeDefined();
      expect(publishCounter).toBeDefined();
      expect(latencyHist).toBeDefined();

      // Start publish
      metrics.recordPublishStart();
      expect(inFlightGauge?.get()).toBe(1);
      expect(metrics.getInFlightCount()).toBe(1);

      // Finish successful publish with 12ms latency
      metrics.recordPublishEnd(12, false);
      expect(inFlightGauge?.get()).toBe(0);
      expect(publishCounter?.get({ status: 'success' })).toBe(1);
      expect(publishCounter?.get({ status: 'error' })).toBe(0);

      const histVal = latencyHist?.getValue();
      expect(histVal?.count).toBe(1);
      expect(histVal?.sum).toBeCloseTo(0.012, 4);

      // Record rejected / error publish
      metrics.recordPublishRejected();
      expect(publishCounter?.get({ status: 'error' })).toBe(1);

      // Preserve backwards compatibility with getSnapshot()
      const snapshot = metrics.getSnapshot();
      expect(snapshot['redis.publish.count']).toBe(1);
      expect(snapshot['redis.publish.errors']).toBe(1);
      expect(snapshot['redis.publish.inFlight']).toBe(0);
      expect(snapshot['redis.publish.latency.avgMs']).toBe(12);
    });

    it('tracks active channel subscriptions count', () => {
      const subsGauge = registry.getGauge('pulse_redis_subscriptions_active');
      metrics.setChannelsActive(5);
      expect(subsGauge?.get()).toBe(5);
      expect(metrics.getSnapshot()['redis.channels.active']).toBe(5);

      metrics.setChannelsActive(0);
      expect(subsGauge?.get()).toBe(0);
      expect(metrics.getSnapshot()['redis.channels.active']).toBe(0);
    });

    it('resets metrics cleanly and zeroes gauges', () => {
      metrics.setConnectionState('connected');
      metrics.recordPublishStart();
      metrics.setChannelsActive(3);

      metrics.reset();

      expect(registry.getGauge('pulse_redis_publish_in_flight')?.get()).toBe(0);
      expect(registry.getGauge('pulse_redis_subscriptions_active')?.get()).toBe(0);
      expect(registry.getGauge('pulse_redis_connection_state')?.get()).toBe(0);

      const snapshot = metrics.getSnapshot();
      expect(snapshot['redis.publish.count']).toBe(0);
      expect(snapshot['redis.channels.active']).toBe(0);
    });

    it('serializes Redis metrics to standard Prometheus text exposition', () => {
      metrics.setConnectionState('connected');
      metrics.recordPublishStart();
      metrics.recordPublishEnd(5, false);
      metrics.setChannelsActive(2);

      const output = PrometheusSerializer.serialize(registry);
      expect(output).toContain('# HELP pulse_redis_connection_state');
      expect(output).toContain('# TYPE pulse_redis_connection_state gauge');
      expect(output).toContain('pulse_redis_connection_state 1');

      expect(output).toContain('# HELP pulse_redis_publish_total');
      expect(output).toContain('# TYPE pulse_redis_publish_total counter');
      expect(output).toContain('pulse_redis_publish_total{status="success"} 1');

      expect(output).toContain('# HELP pulse_redis_publish_duration_seconds');
      expect(output).toContain('# TYPE pulse_redis_publish_duration_seconds histogram');
      expect(output).toContain('pulse_redis_publish_duration_seconds_count 1');

      expect(output).toContain('# HELP pulse_redis_subscriptions_active');
      expect(output).toContain('pulse_redis_subscriptions_active 2');
    });
  });

  describe('Integration: RedisPubSubManager Telemetry Integration', () => {
    let registry: PulseMetricsRegistry;
    let mockConnectionManager: any;
    let mockPublisher: any;
    let mockSubscriber: any;
    let manager: RedisPubSubManager;

    beforeEach(() => {
      registry = new PulseMetricsRegistry();

      mockPublisher = {
        publish: jest.fn().mockResolvedValue(1)
      };

      mockSubscriber = {
        subscribe: jest.fn().mockResolvedValue(1),
        unsubscribe: jest.fn().mockResolvedValue(1),
        on: jest.fn()
      };

      mockConnectionManager = {
        connect: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        isConnected: jest.fn().mockReturnValue(true),
        getPublisher: jest.fn().mockReturnValue(mockPublisher),
        getSubscriber: jest.fn().mockReturnValue(mockSubscriber),
        getStatus: jest.fn().mockReturnValue({ publisher: 'connected', subscriber: 'connected', isConnected: true }),
        on: jest.fn()
      };
      Object.setPrototypeOf(mockConnectionManager, RedisConnectionManager.prototype);

      manager = new RedisPubSubManager(mockConnectionManager, 'test-node-1', 10);
      manager.setMetricsRegistry(registry);
    });

    it('updates metrics during connect, publish, and channel subscription', async () => {
      await manager.connect();

      const stateGauge = registry.getGauge('pulse_redis_connection_state');
      expect(stateGauge?.get()).toBe(1);

      // Subscribe to a channel
      await manager.subscribe('pulse:room:test-channel');
      const subsGauge = registry.getGauge('pulse_redis_subscriptions_active');
      expect(subsGauge?.get()).toBe(1);

      // Publish an event
      await manager.publish('pulse:room:test-channel', {
        eventId: '01a0711c-1234-7000-8000-000000000001',
        type: 'ROOM_MESSAGE',
        timestamp: Date.now(),
        senderId: 'user1',
        target: { roomId: 'test-channel' },
        payload: { text: 'hello' }
      });

      const publishCounter = registry.getCounter('pulse_redis_publish_total');
      expect(publishCounter?.get({ status: 'success' })).toBe(1);

      const hist = registry.getHistogram('pulse_redis_publish_duration_seconds');
      expect(hist?.getValue().count).toBe(1);

      // Disconnect
      await manager.disconnect();
      expect(stateGauge?.get()).toBe(0);
      expect(subsGauge?.get()).toBe(0);
    });

    it('records publish errors when backpressure limit is hit', async () => {
      // Create manager with capacity of 1 in-flight publish
      const tightManager = new RedisPubSubManager(mockConnectionManager, 'tight-node', 1);
      tightManager.setMetricsRegistry(registry);

      // Artificially saturate in-flight publishes
      tightManager.getMetrics().recordPublishStart();

      await expect(
        tightManager.publish('pulse:room:overflow', { data: 'test' })
      ).rejects.toThrow(/backpressure limit reached/);

      const publishCounter = registry.getCounter('pulse_redis_publish_total');
      expect(publishCounter?.get({ status: 'error' })).toBe(1);
    });
  });
});
