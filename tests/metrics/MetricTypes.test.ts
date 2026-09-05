import {
  BOUNDED_EVENT_TYPES,
  BOUNDED_STATUSES,
  BOUNDED_REASONS,
  BOUNDED_DIRECTIONS,
  PROHIBITED_LABEL_KEYS,
  DEFAULT_LATENCY_BUCKETS,
  assertLowCardinalityLabels,
  EventType,
  PulseConfig,
  PulseEventEnvelope
} from '../../src/types/index.js';

describe('Checkpoint 01: Observability Contracts & Bounded Label Types', () => {
  describe('Bounded Label Vocabularies', () => {
    it('defines bounded event types matching all valid Pulse EventTypes', () => {
      expect(BOUNDED_EVENT_TYPES.length).toBe(16);
      const expectedTypes: EventType[] = [
        'SYS_CONNECT_ACK',
        'SYS_PING',
        'SYS_PONG',
        'SYS_ERROR',
        'SYS_SHUTDOWN',
        'ROOM_JOIN',
        'ROOM_JOIN_ACK',
        'ROOM_LEAVE',
        'ROOM_LEAVE_ACK',
        'ROOM_BATCH_JOIN',
        'ROOM_BATCH_JOIN_ACK',
        'ROOM_MESSAGE',
        'DIRECT_MESSAGE',
        'PRESENCE_UPDATE',
        'ROOM_ROSTER',
        'DELIVERY_ACK'
      ];

      for (const t of expectedTypes) {
        expect(BOUNDED_EVENT_TYPES).toContain(t);
      }
    });

    it('defines bounded statuses, reasons, and directions', () => {
      expect(BOUNDED_STATUSES).toContain('success');
      expect(BOUNDED_STATUSES).toContain('error');
      expect(BOUNDED_STATUSES).toContain('rejected');
      expect(BOUNDED_STATUSES).toContain('dropped');

      expect(BOUNDED_REASONS).toContain('heartbeat_timeout');
      expect(BOUNDED_REASONS).toContain('slow_consumer');
      expect(BOUNDED_REASONS).toContain('client_close');
      expect(BOUNDED_REASONS).toContain('unauthorized');
      expect(BOUNDED_REASONS).toContain('duplicate');

      expect(BOUNDED_DIRECTIONS).toContain('published');
      expect(BOUNDED_DIRECTIONS).toContain('received');
    });
  });

  describe('Low-Cardinality Enforcement (assertLowCardinalityLabels)', () => {
    it('accepts valid bounded labels without throwing', () => {
      expect(() => {
        assertLowCardinalityLabels({
          event_type: 'ROOM_MESSAGE',
          status: 'success'
        });
      }).not.toThrow();

      expect(() => {
        assertLowCardinalityLabels(undefined);
      }).not.toThrow();

      expect(() => {
        assertLowCardinalityLabels({});
      }).not.toThrow();
    });

    it('strictly rejects dynamic identifiers as label keys', () => {
      const dynamicKeys = [
        'userId',
        'user_id',
        'connectionId',
        'connection_id',
        'roomId',
        'room_id',
        'eventId',
        'event_id',
        'instanceId',
        'instance_id',
        'error',
        'error_message',
        'payload'
      ];

      for (const key of dynamicKeys) {
        expect(() => {
          assertLowCardinalityLabels({ [key]: 'dynamic-value-123' });
        }).toThrow(/Low-cardinality violation/);
      }
    });

    it('enforces case-insensitivity on prohibited label keys', () => {
      expect(() => {
        assertLowCardinalityLabels({ USERID: 'usr_abc123' });
      }).toThrow(/Low-cardinality violation/);

      expect(() => {
        assertLowCardinalityLabels({ Room_Id: 'room_general' });
      }).toThrow(/Low-cardinality violation/);

      expect(() => {
        assertLowCardinalityLabels({ EventId: 'evt_0190' });
      }).toThrow(/Low-cardinality violation/);
    });

    it('rejects excessively long label values to prevent memory bloat', () => {
      const longValue = 'a'.repeat(65);
      expect(() => {
        assertLowCardinalityLabels({ reason: longValue });
      }).toThrow(/Invalid label value/);
    });
  });

  describe('Approved Latency Buckets', () => {
    it('contains the approved 11 latency bucket boundaries in ascending order', () => {
      expect(DEFAULT_LATENCY_BUCKETS).toEqual([
        0.0005,
        0.001,
        0.002,
        0.005,
        0.010,
        0.025,
        0.050,
        0.100,
        0.250,
        0.500,
        1.000
      ]);

      for (let i = 1; i < DEFAULT_LATENCY_BUCKETS.length; i++) {
        expect(DEFAULT_LATENCY_BUCKETS[i]).toBeGreaterThan(DEFAULT_LATENCY_BUCKETS[i - 1]);
      }
    });
  });

  describe('Type Contracts Extension', () => {
    it('allows metrics configuration on PulseConfig', () => {
      const config: PulseConfig = {
        port: 8080,
        host: '0.0.0.0',
        nodeEnv: 'test',
        instanceId: 'test-node-1',
        heartbeatIntervalMs: 30000,
        heartbeatTimeoutMs: 10000,
        maxPayloadBytes: 65536,
        authSecret: 'test-secret-32-chars-long-enough!',
        metricsEnabled: true,
        metricsPath: '/metrics',
        eventLoopMonitorIntervalMs: 10000
      };

      expect(config.metricsEnabled).toBe(true);
      expect(config.metricsPath).toBe('/metrics');
      expect(config.eventLoopMonitorIntervalMs).toBe(10000);
    });

    it('allows originTimestampMs on PulseEventEnvelope for cross-node latency', () => {
      const envelope: PulseEventEnvelope = {
        eventId: '018e3a2b-8a7c-7a91-b1e2-5f6e8a9b0c1d',
        type: 'ROOM_MESSAGE',
        timestamp: Date.now(),
        originTimestampMs: Date.now() - 5,
        senderId: 'user-1',
        payload: { text: 'hello' }
      };

      expect(envelope.originTimestampMs).toBeDefined();
      expect(envelope.originTimestampMs).toBeLessThanOrEqual(envelope.timestamp);
    });
  });
});
