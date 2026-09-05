/**
 * Pulse — Distributed Real-Time Messaging Infrastructure
 * Checkpoint 11: Cross-Node Transit Latency Instrumentation Tests
 */

import { EventValidator } from '../../src/events/EventValidator.js';
import { MessageDispatcher } from '../../src/core/MessageDispatcher.js';
import { ConnectionManager } from '../../src/core/ConnectionManager.js';
import { RoomManager } from '../../src/core/RoomManager.js';
import { IdempotencyManager } from '../../src/core/IdempotencyManager.js';
import { PulseMetricsRegistry } from '../../src/metrics/PulseMetricsRegistry.js';
import { registerRedisMetrics, registerWebSocketMetrics } from '../../src/metrics/telemetry.js';
import { PrometheusSerializer } from '../../src/metrics/PrometheusSerializer.js';
import { PulseEventEnvelope } from '../../src/types/index.js';

describe('Checkpoint 11: Cross-Node Transit Latency Instrumentation', () => {
  describe('EventValidator: Distributed Stamping & Validation', () => {
    it('stamps originInstanceId and originTimestampMs with current time', () => {
      const baseEnvelope: PulseEventEnvelope = {
        eventId: '01990000-0000-7000-8000-000000000001',
        type: 'ROOM_MESSAGE',
        timestamp: Date.now() - 100,
        senderId: 'user-1',
        seq: 42,
        target: { roomId: 'general' },
        payload: { text: 'hello' }
      };

      const before = Date.now();
      const stamped = EventValidator.stampForDistribution(baseEnvelope, 'node-east');
      const after = Date.now();

      expect(stamped.originInstanceId).toBe('node-east');
      expect(stamped.originTimestampMs).toBeGreaterThanOrEqual(before);
      expect(stamped.originTimestampMs).toBeLessThanOrEqual(after);
      expect(stamped.seq).toBeUndefined(); // connection-local seq stripped
    });

    it('allows explicit originTimestampMs in stampForDistribution', () => {
      const baseEnvelope: PulseEventEnvelope = {
        eventId: '01990000-0000-7000-8000-000000000002',
        type: 'DIRECT_MESSAGE',
        timestamp: Date.now(),
        senderId: 'user-1',
        target: { recipientId: 'user-2' },
        payload: { text: 'direct' }
      };

      const customTimestamp = 1700000000000;
      const stamped = EventValidator.stampForDistribution(baseEnvelope, 'node-west', customTimestamp);

      expect(stamped.originInstanceId).toBe('node-west');
      expect(stamped.originTimestampMs).toBe(customTimestamp);
    });

    it('preserves valid originTimestampMs through validateDistributed', () => {
      const rawDistributed = {
        eventId: '01990000-0000-7000-8000-000000000003',
        type: 'ROOM_MESSAGE',
        timestamp: Date.now(),
        senderId: 'user-1',
        target: { roomId: 'general' },
        payload: { text: 'hi' },
        originInstanceId: 'node-remote',
        originTimestampMs: 1725500000000
      };

      const result = EventValidator.validateDistributed(rawDistributed);
      expect(result.valid).toBe(true);
      expect(result.envelope?.originTimestampMs).toBe(1725500000000);
      expect(result.envelope?.originInstanceId).toBe('node-remote');
    });

    it('rejects invalid non-number originTimestampMs in incoming validation', () => {
      const rawInvalid = {
        eventId: '01990000-0000-7000-8000-000000000004',
        type: 'ROOM_MESSAGE',
        timestamp: Date.now(),
        senderId: 'user-1',
        target: { roomId: 'general' },
        payload: { text: 'bad timestamp' },
        originInstanceId: 'node-remote',
        originTimestampMs: 'not-a-number'
      };

      const result = EventValidator.validateDistributed(rawInvalid);
      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe('INVALID_ORIGIN_TIMESTAMP');
    });
  });

  describe('MessageDispatcher: Cross-Node Transit Latency Histogram', () => {
    let registry: PulseMetricsRegistry;
    let dispatcher: MessageDispatcher;
    let connectionManager: ConnectionManager;
    let roomManager: RoomManager;
    let idempotencyManager: IdempotencyManager;

    beforeEach(() => {
      registry = new PulseMetricsRegistry();
      registerWebSocketMetrics(registry);
      registerRedisMetrics(registry);

      connectionManager = new ConnectionManager();
      roomManager = new RoomManager();
      idempotencyManager = new IdempotencyManager({ capacity: 1000, ttlMs: 60000 });

      dispatcher = new MessageDispatcher({
        connectionManager,
        roomManager,
        idempotencyManager,
        metricsRegistry: registry,
        instanceId: 'local-node'
      });
    });

    it('records normal cross-node transit latency (e.g. 25ms = 0.025s)', () => {
      const now = Date.now();
      const originTime = now - 25; // 25ms transit duration

      const envelope: PulseEventEnvelope = {
        eventId: '01990000-0000-7000-8000-000000000010',
        type: 'ROOM_MESSAGE',
        timestamp: originTime,
        senderId: 'remote-user',
        originInstanceId: 'remote-node',
        originTimestampMs: originTime,
        target: { roomId: 'general' },
        payload: { msg: 'normal transit' }
      };

      dispatcher.handleInboundRedisEvent('pulse:room:general', envelope);

      const histogram = registry.getHistogram('pulse_cross_node_transit_seconds');
      expect(histogram).toBeDefined();

      const snapshot = histogram!.getValue();
      expect(snapshot.count).toBe(1);
      // Measured delta is at least 25ms (0.025s) and within reasonable execution window
      expect(snapshot.sum).toBeGreaterThanOrEqual(0.024);
      expect(snapshot.sum).toBeLessThan(0.100);
    });

    it('handles and records zero latency when originTimestampMs matches receive time', () => {
      const now = Date.now();

      const envelope: PulseEventEnvelope = {
        eventId: '01990000-0000-7000-8000-000000000011',
        type: 'ROOM_MESSAGE',
        timestamp: now,
        senderId: 'remote-user',
        originInstanceId: 'remote-node',
        originTimestampMs: now,
        target: { roomId: 'general' },
        payload: { msg: 'zero latency' }
      };

      dispatcher.handleInboundRedisEvent('pulse:room:general', envelope);

      const histogram = registry.getHistogram('pulse_cross_node_transit_seconds');
      expect(histogram).toBeDefined();

      const snapshot = histogram!.getValue();
      expect(snapshot.count).toBe(1);
      // Delta should be tiny (near 0, falling into 0.0005s bucket)
      expect(snapshot.buckets[0].count).toBe(1); // bucket 0.0005
    });

    it('clamps negative clock skew to zero (when remote clock is in the future)', () => {
      const now = Date.now();
      // Remote clock is 50ms ahead of local receiver clock (negative transit delta)
      const futureOriginTime = now + 50;

      const envelope: PulseEventEnvelope = {
        eventId: '01990000-0000-7000-8000-000000000012',
        type: 'ROOM_MESSAGE',
        timestamp: futureOriginTime,
        senderId: 'remote-user',
        originInstanceId: 'remote-node',
        originTimestampMs: futureOriginTime,
        target: { roomId: 'general' },
        payload: { msg: 'clock skew' }
      };

      dispatcher.handleInboundRedisEvent('pulse:room:general', envelope);

      const histogram = registry.getHistogram('pulse_cross_node_transit_seconds');
      const snapshot = histogram!.getValue();

      expect(snapshot.count).toBe(1);
      // Clamped to 0, sum must be exactly 0, and bucket le="0.0005" must catch it
      expect(snapshot.sum).toBe(0);
      expect(snapshot.buckets[0].count).toBe(1); // bucket 0.0005
    });

    it('does not record cross-node transit latency on self-echo events', () => {
      const now = Date.now();

      const envelope: PulseEventEnvelope = {
        eventId: '01990000-0000-7000-8000-000000000013',
        type: 'ROOM_MESSAGE',
        timestamp: now - 10,
        senderId: 'local-user',
        originInstanceId: 'local-node', // Self echo!
        originTimestampMs: now - 10,
        target: { roomId: 'general' },
        payload: { msg: 'self-echo' }
      };

      const result = dispatcher.handleInboundRedisEvent('pulse:room:general', envelope);
      expect(result).toBe(false); // suppressed

      const histogram = registry.getHistogram('pulse_cross_node_transit_seconds');
      expect(histogram!.getValue().count).toBe(0);
    });

    it('serializes cross-node transit histogram to valid Prometheus exposition format', () => {
      const now = Date.now();
      const envelope: PulseEventEnvelope = {
        eventId: '01990000-0000-7000-8000-000000000014',
        type: 'ROOM_MESSAGE',
        timestamp: now - 5,
        senderId: 'remote-user',
        originInstanceId: 'remote-node',
        originTimestampMs: now - 5,
        target: { roomId: 'general' },
        payload: { msg: 'serialize test' }
      };

      dispatcher.handleInboundRedisEvent('pulse:room:general', envelope);

      const output = PrometheusSerializer.serialize(registry);
      expect(output).toContain('# HELP pulse_cross_node_transit_seconds');
      expect(output).toContain('# TYPE pulse_cross_node_transit_seconds histogram');
      expect(output).toContain('pulse_cross_node_transit_seconds_bucket{le="0.0005"}');
      expect(output).toContain('pulse_cross_node_transit_seconds_bucket{le="+Inf"} 1');
      expect(output).toContain('pulse_cross_node_transit_seconds_count 1');
    });
  });
});
