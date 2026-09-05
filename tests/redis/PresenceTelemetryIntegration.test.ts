/**
 * Pulse — Distributed Real-Time Messaging Infrastructure
 * Checkpoint 12: Distributed Presence Telemetry Integration Tests
 */

import { PresenceManager } from '../../src/redis/PresenceManager.js';
import { PulseMetricsRegistry } from '../../src/metrics/PulseMetricsRegistry.js';
import { PrometheusSerializer } from '../../src/metrics/PrometheusSerializer.js';
import { registerPresenceMetrics } from '../../src/metrics/telemetry.js';

describe('Checkpoint 12: Distributed Presence Telemetry Integration', () => {
  let mockRedis: any;
  let registry: PulseMetricsRegistry;
  let presenceManager: PresenceManager;

  beforeEach(() => {
    registry = new PulseMetricsRegistry();
    registerPresenceMetrics(registry);

    // Mock Redis client
    mockRedis = {
      eval: jest.fn().mockResolvedValue(1),
      zcard: jest.fn().mockResolvedValue(1),
      zremrangebyscore: jest.fn().mockResolvedValue(2),
      zrangebyscore: jest.fn().mockResolvedValue(['node-1:conn-1']),
      pipeline: jest.fn().mockReturnValue({
        zadd: jest.fn().mockReturnThis(),
        expire: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([[null, 1], [null, 1]])
      }),
      sadd: jest.fn().mockResolvedValue(1),
      srem: jest.fn().mockResolvedValue(1),
      smembers: jest.fn().mockResolvedValue(['user-1', 'user-2'])
    };

    presenceManager = new PresenceManager(mockRedis, 'node-1', {
      presenceTtlMs: 30000,
      presenceFlushIntervalMs: 10000,
      metricsRegistry: registry
    });
  });

  describe('Gauges: Online Users & Active Presence Connections', () => {
    it('updates online users and active connections gauges on registration', async () => {
      const usersGauge = registry.getGauge('pulse_presence_users_online');
      const connsGauge = registry.getGauge('pulse_presence_connections_active');
      const opsCounter = registry.getCounter('pulse_presence_operations_total');

      expect(usersGauge?.get()).toBe(0);
      expect(connsGauge?.get()).toBe(0);

      // Register first connection for user-1
      await presenceManager.registerConnection('user-1', 'conn-1');

      expect(usersGauge?.get()).toBe(1);
      expect(connsGauge?.get()).toBe(1);
      expect(opsCounter?.get({ operation: 'register', status: 'success' })).toBe(1);

      // Register second connection for same user (multi-device)
      await presenceManager.registerConnection('user-1', 'conn-2');

      expect(usersGauge?.get()).toBe(1); // 1 distinct user
      expect(connsGauge?.get()).toBe(2); // 2 active connections
      expect(opsCounter?.get({ operation: 'register', status: 'success' })).toBe(2);

      // Register connection for user-2
      await presenceManager.registerConnection('user-2', 'conn-3');

      expect(usersGauge?.get()).toBe(2);
      expect(connsGauge?.get()).toBe(3);
    });

    it('decrements active connections and online users on connection removal', async () => {
      const usersGauge = registry.getGauge('pulse_presence_users_online');
      const connsGauge = registry.getGauge('pulse_presence_connections_active');
      const opsCounter = registry.getCounter('pulse_presence_operations_total');

      await presenceManager.registerConnection('user-1', 'conn-1');
      await presenceManager.registerConnection('user-1', 'conn-2');
      expect(usersGauge?.get()).toBe(1);
      expect(connsGauge?.get()).toBe(2);

      // Remove conn-1 (user remains online via conn-2)
      await presenceManager.removeConnection('user-1', 'conn-1');
      expect(usersGauge?.get()).toBe(1);
      expect(connsGauge?.get()).toBe(1);
      expect(opsCounter?.get({ operation: 'remove', status: 'success' })).toBe(1);

      // Remove conn-2 (user goes offline)
      await presenceManager.removeConnection('user-1', 'conn-2');
      expect(usersGauge?.get()).toBe(0);
      expect(connsGauge?.get()).toBe(0);
      expect(opsCounter?.get({ operation: 'remove', status: 'success' })).toBe(2);
    });
  });

  describe('Counter: Lease Renewals', () => {
    it('records batch lease renewals in pulse_presence_lease_renewals_total', async () => {
      const renewalsCounter = registry.getCounter('pulse_presence_lease_renewals_total');
      expect(renewalsCounter).toBeDefined();

      await presenceManager.registerConnection('user-1', 'conn-1');
      await presenceManager.registerConnection('user-2', 'conn-2');

      // Flush renewals for 2 active connections
      const flushed = await presenceManager.flushLeaseRenewals();
      expect(flushed).toBe(2);
      expect(renewalsCounter?.get()).toBe(2);

      // Flush again
      await presenceManager.flushLeaseRenewals();
      expect(renewalsCounter?.get()).toBe(4);
    });
  });

  describe('Histogram: Prune Duration & Latency', () => {
    it('records prune duration into pulse_presence_prune_duration_seconds histogram', async () => {
      const pruneHist = registry.getHistogram('pulse_presence_prune_duration_seconds');
      expect(pruneHist).toBeDefined();

      const prunedCount = await presenceManager.pruneExpired('user-1');
      expect(prunedCount).toBe(2);

      const snapshot = pruneHist!.getValue();
      expect(snapshot.count).toBe(1);
      expect(snapshot.sum).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Fail-Open Behavior: Error Counting & Metric Continuity', () => {
    it('increments error operation counter when Redis fails and preserves fail-open behavior', async () => {
      mockRedis.eval.mockRejectedValueOnce(new Error('Redis connection lost'));

      const opsCounter = registry.getCounter('pulse_presence_operations_total');
      const result = await presenceManager.registerConnection('user-1', 'conn-fail');

      expect(result.isOnlineTransition).toBe(false);
      expect(opsCounter?.get({ operation: 'register', status: 'error' })).toBe(1);
    });
  });

  describe('Prometheus Text Serialization', () => {
    it('serializes presence metrics conforming to Prometheus 0.0.4 specification', async () => {
      await presenceManager.registerConnection('user-1', 'conn-1');
      await presenceManager.flushLeaseRenewals();
      await presenceManager.pruneExpired('user-1');
      presenceManager.recordInboundEvent();

      const output = PrometheusSerializer.serialize(registry);

      expect(output).toContain('# HELP pulse_presence_users_online');
      expect(output).toContain('# TYPE pulse_presence_users_online gauge');
      expect(output).toContain('pulse_presence_users_online 1');

      expect(output).toContain('# HELP pulse_presence_connections_active');
      expect(output).toContain('pulse_presence_connections_active 1');

      expect(output).toContain('# HELP pulse_presence_lease_renewals_total');
      expect(output).toContain('pulse_presence_lease_renewals_total 1');

      expect(output).toContain('# HELP pulse_presence_prune_duration_seconds');
      expect(output).toContain('pulse_presence_prune_duration_seconds_count 1');

      expect(output).toContain('# HELP pulse_presence_events_total');
      expect(output).toContain('pulse_presence_events_total{direction="received"} 1');

      expect(output).toContain('# HELP pulse_presence_operations_total');
      expect(output).toContain('pulse_presence_operations_total{operation="register",status="success"} 1');
    });
  });
});
