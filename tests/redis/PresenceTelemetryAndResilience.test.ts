import http from 'http';
import WebSocket from 'ws';
import RedisMock from 'ioredis-mock';
import { PulseServer } from '../../src/core/PulseServer.js';
import { PresenceManager } from '../../src/redis/PresenceManager.js';
import { RedisPubSubManager } from '../../src/redis/RedisPubSubManager.js';
import { RedisConnectionManager } from '../../src/redis/RedisConnectionManager.js';
import { RedisMetrics } from '../../src/redis/RedisMetrics.js';
import { PulseConfig, PulseEventEnvelope } from '../../src/types/index.js';
import { Connection } from '../../src/core/Connection.js';
import { ConnectionManager } from '../../src/core/ConnectionManager.js';
import { RoomManager } from '../../src/core/RoomManager.js';
import { MessageDispatcher } from '../../src/core/MessageDispatcher.js';

describe('Presence Resilience & Telemetry', () => {
  describe('PresenceManager Metrics Tracking', () => {
    let redis: any;
    let pubSubManager: any;
    let presenceManager: PresenceManager;

    beforeEach(() => {
      redis = new (RedisMock as any)();
      const metrics = new RedisMetrics();
      pubSubManager = {
        isConnected: jest.fn().mockReturnValue(true),
        publishPresence: jest.fn().mockResolvedValue(1),
        getMetrics: () => metrics
      };

      presenceManager = new PresenceManager(redis, 'node-metrics', {
        pubSubManager,
        presenceTtlMs: 60000,
        presenceFlushIntervalMs: 15000
      });
    });

    afterEach(async () => {
      presenceManager.stopRenewalLoop();
      await redis.flushall();
      jest.restoreAllMocks();
    });

    it('accurately tracks online users, active connections, publications, and renewals', async () => {
      // 1. Initial snapshot: all zeroes
      let snapshot = presenceManager.getMetricsSnapshot();
      expect(snapshot['presence.users.online']).toBe(0);
      expect(snapshot['presence.connections.active']).toBe(0);
      expect(snapshot['presence.events.published']).toBe(0);
      expect(snapshot['presence.events.received']).toBe(0);
      expect(snapshot['presence.lease.renewals']).toBe(0);

      // 2. Register connections for Alice and Bob
      await presenceManager.registerConnection('alice', 'conn-a-1');
      await presenceManager.registerConnection('alice', 'conn-a-2'); // second device for Alice
      await presenceManager.registerConnection('bob', 'conn-b-1');

      snapshot = presenceManager.getMetricsSnapshot();
      expect(snapshot['presence.users.online']).toBe(2);
      expect(snapshot['presence.connections.active']).toBe(3);
      // Online transitions for Alice (0 -> 1) and Bob (0 -> 1): 2 published events
      expect(snapshot['presence.events.published']).toBe(2);

      // 3. Record inbound event
      presenceManager.recordInboundEvent();
      snapshot = presenceManager.getMetricsSnapshot();
      expect(snapshot['presence.events.received']).toBe(1);

      // 4. Flush lease renewals
      const renewed = await presenceManager.flushLeaseRenewals();
      expect(renewed).toBe(3);

      snapshot = presenceManager.getMetricsSnapshot();
      expect(snapshot['presence.lease.renewals']).toBe(3);

      // 5. Measure prune latency
      await presenceManager.pruneExpired('alice');
      snapshot = presenceManager.getMetricsSnapshot();
      expect(typeof snapshot['presence.prune.latency.ms']).toBe('number');
      expect(snapshot['presence.prune.latency.ms']).toBeGreaterThanOrEqual(0);

      // 6. Verify metrics propagated to RedisMetrics
      const redisSnapshot = pubSubManager.getMetrics().getSnapshot();
      expect(redisSnapshot['presence.users.online']).toBe(2);
      expect(redisSnapshot['presence.connections.active']).toBe(3);
      expect(redisSnapshot['presence.events.published']).toBe(2);
      expect(redisSnapshot['presence.events.received']).toBe(1);
      expect(redisSnapshot['presence.lease.renewals']).toBe(3);
    });
  });

  describe('Health Endpoint Observability & Degraded States', () => {
    let server: PulseServer;
    let testPort: number;
    let mockPubSub: any;
    let redisMock: any;
    let presenceManager: PresenceManager;

    beforeEach(async () => {
      testPort = 9200 + Math.floor(Math.random() * 700);
      redisMock = new (RedisMock as any)();

      let connected = true;
      mockPubSub = {
        connect: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockImplementation(async () => {
          connected = false;
        }),
        isConnected: jest.fn().mockImplementation(() => connected),
        getStatus: jest.fn().mockImplementation(() => ({
          publisher: connected ? 'connected' : 'disconnected',
          subscriber: connected ? 'connected' : 'disconnected',
          isConnected: connected
        })),
        getMetricsSnapshot: jest.fn().mockReturnValue({}),
        onMessage: jest.fn()
      };

      presenceManager = new PresenceManager(redisMock, 'node-health-test', {
        presenceTtlMs: 60000
      });

      const config: PulseConfig = {
        port: testPort,
        host: '127.0.0.1',
        nodeEnv: 'test',
        instanceId: 'node-health-test',
        heartbeatIntervalMs: 5000,
        heartbeatTimeoutMs: 2000,
        maxPayloadBytes: 1024 * 1024,
        authSecret: 'test-presence-telemetry-secret-123456789',
        redisEnabled: true
      };

      server = new PulseServer(config, {}, {
        redisPubSubManager: mockPubSub,
        presenceManager
      });

      await server.start();
    });

    afterEach(async () => {
      await server.stop();
      jest.restoreAllMocks();
    });

    const getHealth = (): Promise<{ statusCode: number; body: any }> => {
      return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${testPort}/healthz`, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            resolve({ statusCode: res.statusCode || 0, body: JSON.parse(data) });
          });
        }).on('error', reject);
      });
    };

    it('reports status: OK and mode: distributed when Redis is connected', async () => {
      const { statusCode, body } = await getHealth();

      expect(statusCode).toBe(200);
      expect(body.status).toBe('OK');
      expect(body.presence.enabled).toBe(true);
      expect(body.presence.mode).toBe('distributed');
      expect(body.presence.metrics).toBeDefined();
      expect(body.presence.metrics['presence.users.online']).toBe(0);
    });

    it('reports status: DEGRADED and mode: degraded-local-only when Redis is disconnected without returning 500/503', async () => {
      // Simulate Redis disconnect
      mockPubSub.isConnected.mockReturnValue(false);
      mockPubSub.getStatus.mockReturnValue({
        publisher: 'disconnected',
        subscriber: 'disconnected',
        isConnected: false
      });

      const { statusCode, body } = await getHealth();

      // Server must remain accessible (HTTP 200) with status DEGRADED, not dead (503)
      expect(statusCode).toBe(200);
      expect(body.status).toBe('DEGRADED');
      expect(body.redis.isConnected).toBe(false);
      expect(body.presence.enabled).toBe(true);
      expect(body.presence.mode).toBe('degraded-local-only');
      expect(body.presence.metrics).toBeDefined();
    });
  });
});
