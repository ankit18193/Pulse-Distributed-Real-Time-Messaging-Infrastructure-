import { RedisMetrics } from '../../src/redis/RedisMetrics.js';
import { RedisPubSubManager } from '../../src/redis/RedisPubSubManager.js';
import { RedisConnectionManager } from '../../src/redis/RedisConnectionManager.js';
import { MessageDispatcher } from '../../src/core/MessageDispatcher.js';
import { ConnectionManager } from '../../src/core/ConnectionManager.js';
import { RoomManager } from '../../src/core/RoomManager.js';
import RedisMock from 'ioredis-mock';

describe('Redis Metrics and Bounded Backpressure', () => {
  describe('RedisMetrics Unit', () => {
    test('tracks and calculates publish, inbound, and suppression metrics', () => {
      const metrics = new RedisMetrics();

      metrics.recordPublishStart();
      expect(metrics.getInFlightCount()).toBe(1);

      metrics.recordPublishEnd(10, false);
      expect(metrics.getInFlightCount()).toBe(0);

      metrics.recordPublishStart();
      metrics.recordPublishEnd(20, false);

      metrics.recordPublishStart();
      metrics.recordPublishEnd(0, true); // error

      metrics.recordInbound(5);
      metrics.recordEchoSuppressed();
      metrics.recordDuplicateSuppressed();
      metrics.setChannelsActive(3);
      metrics.setConnectionState('connected');

      const snapshot = metrics.getSnapshot();
      expect(snapshot['redis.publish.count']).toBe(2);
      expect(snapshot['redis.publish.errors']).toBe(1);
      expect(snapshot['redis.publish.latency.avgMs']).toBe(15);
      expect(snapshot['redis.publish.latency.maxMs']).toBe(20);
      expect(snapshot['redis.publish.inFlight']).toBe(0);

      expect(snapshot['redis.inbound.count']).toBe(1);
      expect(snapshot['redis.inbound.latency.avgMs']).toBe(5);
      expect(snapshot['redis.echoes.suppressed']).toBe(1);
      expect(snapshot['redis.duplicates.suppressed']).toBe(1);
      expect(snapshot['redis.channels.active']).toBe(3);
      expect(snapshot['redis.connection.state']).toBe('connected');
    });
  });

  describe('Bounded Backpressure on Publish', () => {
    test('enforces max in-flight publish limit and rejects with backpressure error', async () => {
      const resolvers: Array<() => void> = [];
      const mockPublisher = new RedisMock();
      const mockSubscriber = new RedisMock();

      jest.spyOn(mockPublisher, 'publish').mockImplementation(() => {
        return new Promise<number>((resolve) => {
          resolvers.push(() => resolve(1));
        });
      });

      const connManager = new RedisConnectionManager({
        customClientFactory: (role) => (role === 'publisher' ? mockPublisher : mockSubscriber)
      });

      // Set maxInFlightPublishes to 2
      const pubSub = new RedisPubSubManager(connManager, 'node-bp', 2);
      await pubSub.connect();

      // Launch 2 concurrent publishes (fills capacity)
      const p1 = pubSub.publish('pulse:room:test', { msg: 1 });
      const p2 = pubSub.publish('pulse:room:test', { msg: 2 });

      expect(pubSub.getMetrics().getInFlightCount()).toBe(2);

      // 3rd concurrent publish must be rejected immediately by backpressure limit
      await expect(
        pubSub.publish('pulse:room:test', { msg: 3 })
      ).rejects.toThrow('Redis publish backpressure limit reached (2 in-flight)');

      expect(pubSub.getMetricsSnapshot()['redis.publish.errors']).toBe(1);

      // Resolve in-flight publishes
      while (resolvers.length > 0) {
        resolvers.pop()!();
      }
      await Promise.all([p1, p2]);

      expect(pubSub.getMetrics().getInFlightCount()).toBe(0);

      // Capacity freed: new publish succeeds
      const p4Promise = pubSub.publish('pulse:room:test', { msg: 4 });
      while (resolvers.length > 0) {
        resolvers.pop()!();
      }
      await p4Promise;

      expect(pubSub.getMetricsSnapshot()['redis.publish.count']).toBe(3);
    });
  });

  describe('Inbound Metrics Through MessageDispatcher', () => {
    test('increments echo and duplicate suppression metrics correctly', () => {
      const connManager = new ConnectionManager();
      const roomManager = new RoomManager();
      const pubSub = new RedisPubSubManager({
        customClientFactory: () => new RedisMock()
      }, 'node-metrics');

      const dispatcher = new MessageDispatcher({
        connectionManager: connManager,
        roomManager,
        redisPubSubManager: pubSub,
        instanceId: 'node-metrics'
      });

      // 1. Self-echo event
      const echoEvent = {
        eventId: '018f673a-4421-7299-8d18-000000000051',
        type: 'ROOM_MESSAGE',
        timestamp: Date.now(),
        senderId: 'alice',
        originInstanceId: 'node-metrics', // Matches local instanceId!
        target: { roomId: 'general' },
        payload: { text: 'Echo' }
      };

      dispatcher.handleInboundRedisEvent('pulse:room:general', echoEvent);
      expect(pubSub.getMetricsSnapshot()['redis.echoes.suppressed']).toBe(1);

      // 2. Remote event (first delivery)
      const remoteEvent = {
        eventId: '018f673a-4421-7299-8d18-000000000052',
        type: 'ROOM_MESSAGE',
        timestamp: Date.now(),
        senderId: 'bob',
        originInstanceId: 'node-remote',
        target: { roomId: 'general' },
        payload: { text: 'Remote 1' }
      };

      dispatcher.handleInboundRedisEvent('pulse:room:general', remoteEvent);
      expect(pubSub.getMetricsSnapshot()['redis.inbound.count']).toBe(1);

      // 3. Duplicate of remote event
      dispatcher.handleInboundRedisEvent('pulse:room:general', remoteEvent);
      expect(pubSub.getMetricsSnapshot()['redis.duplicates.suppressed']).toBe(1);
    });
  });
});
