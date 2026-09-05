import { Counter } from '../../src/metrics/Counter.js';
import { Gauge } from '../../src/metrics/Gauge.js';

describe('Checkpoint 03: Fast Counters and Gauges', () => {
  describe('Counter Primitive', () => {
    it('initializes to 0 for unlabeled counter', () => {
      const counter = new Counter({
        name: 'pulse_messages_total',
        help: 'Total messages processed'
      });

      expect(counter.get()).toBe(0);
      expect(counter.name).toBe('pulse_messages_total');
      expect(counter.type).toBe('counter');
      expect(counter.collect()).toEqual([{ name: 'pulse_messages_total', value: 0 }]);
    });

    it('monotonically increments with default and explicit positive values', () => {
      const counter = new Counter({
        name: 'pulse_messages_total',
        help: 'Total messages processed'
      });

      counter.inc();
      expect(counter.get()).toBe(1);

      counter.inc(undefined, 5);
      expect(counter.get()).toBe(6);

      counter.inc(undefined, 0.5);
      expect(counter.get()).toBe(6.5);
    });

    it('strictly rejects negative increment values', () => {
      const counter = new Counter({
        name: 'pulse_messages_total',
        help: 'Total messages processed'
      });

      expect(() => {
        counter.inc(undefined, -1);
      }).toThrow(/must be a non-negative number/);

      expect(() => {
        counter.inc(undefined, NaN);
      }).toThrow(/must be a non-negative number/);
    });

    it('manages bounded labels cleanly and supports independent series', () => {
      const counter = new Counter({
        name: 'pulse_messages_received_total',
        help: 'Inbound messages by event type',
        labelNames: ['event_type']
      });

      counter.inc({ event_type: 'ROOM_MESSAGE' }, 10);
      counter.inc({ event_type: 'DIRECT_MESSAGE' }, 5);
      counter.inc({ event_type: 'ROOM_MESSAGE' }, 2);

      expect(counter.get({ event_type: 'ROOM_MESSAGE' })).toBe(12);
      expect(counter.get({ event_type: 'DIRECT_MESSAGE' })).toBe(5);
      expect(counter.get({ event_type: 'SYS_PING' })).toBe(0);

      const samples = counter.collect();
      expect(samples).toHaveLength(2);
      expect(samples).toContainEqual({
        name: 'pulse_messages_received_total',
        labels: { event_type: 'ROOM_MESSAGE' },
        value: 12
      });
      expect(samples).toContainEqual({
        name: 'pulse_messages_received_total',
        labels: { event_type: 'DIRECT_MESSAGE' },
        value: 5
      });
    });

    it('enforces low-cardinality invariants on labeled increments', () => {
      const counter = new Counter({
        name: 'test_counter',
        help: 'test',
        labelNames: ['event_type']
      });

      expect(() => {
        counter.inc({ userId: 'usr_123', event_type: 'ROOM_MESSAGE' });
      }).toThrow(/Low-cardinality violation/);
    });

    it('resets all counter series to zero', () => {
      const counter = new Counter({
        name: 'test_counter',
        help: 'test',
        labelNames: ['event_type']
      });

      counter.inc({ event_type: 'ROOM_MESSAGE' }, 20);
      counter.reset();

      expect(counter.get({ event_type: 'ROOM_MESSAGE' })).toBe(0);
      const samples = counter.collect();
      expect(samples[0].value).toBe(0);
    });
  });

  describe('Gauge Primitive', () => {
    it('initializes to 0 for unlabeled gauge', () => {
      const gauge = new Gauge({
        name: 'pulse_connections_active',
        help: 'Active WebSocket connections'
      });

      expect(gauge.get()).toBe(0);
      expect(gauge.name).toBe('pulse_connections_active');
      expect(gauge.type).toBe('gauge');
    });

    it('supports set, inc, and dec operations', () => {
      const gauge = new Gauge({
        name: 'pulse_connections_active',
        help: 'Active connections'
      });

      gauge.set(100);
      expect(gauge.get()).toBe(100);

      gauge.inc();
      expect(gauge.get()).toBe(101);

      gauge.inc(undefined, 10);
      expect(gauge.get()).toBe(111);

      gauge.dec();
      expect(gauge.get()).toBe(110);

      gauge.dec(undefined, 50);
      expect(gauge.get()).toBe(60);

      gauge.set(0);
      expect(gauge.get()).toBe(0);

      gauge.dec(undefined, 5);
      expect(gauge.get()).toBe(-5);
    });

    it('rejects invalid non-numeric inputs', () => {
      const gauge = new Gauge({
        name: 'test_gauge',
        help: 'test'
      });

      expect(() => {
        gauge.set(NaN);
      }).toThrow(/valid number/);

      expect(() => {
        gauge.inc(undefined, NaN);
      }).toThrow(/valid number/);

      expect(() => {
        gauge.dec(undefined, 'invalid' as any);
      }).toThrow(/valid number/);
    });

    it('tracks independent labeled gauge series', () => {
      const gauge = new Gauge({
        name: 'pulse_redis_publish_in_flight',
        help: 'In-flight publishes by status',
        labelNames: ['status']
      });

      gauge.inc({ status: 'success' }, 3);
      gauge.inc({ status: 'rejected' }, 1);
      gauge.dec({ status: 'success' }, 1);

      expect(gauge.get({ status: 'success' })).toBe(2);
      expect(gauge.get({ status: 'rejected' })).toBe(1);
      expect(gauge.get({ status: 'error' })).toBe(0);
    });

    it('enforces low-cardinality invariants on gauge updates', () => {
      const gauge = new Gauge({
        name: 'test_gauge',
        help: 'test',
        labelNames: ['status']
      });

      expect(() => {
        gauge.set(10, { connectionId: 'conn_999' });
      }).toThrow(/Low-cardinality violation/);
    });

    it('resets gauge series to zero on reset()', () => {
      const gauge = new Gauge({
        name: 'test_gauge',
        help: 'test',
        labelNames: ['status']
      });

      gauge.set(50, { status: 'success' });
      gauge.reset();

      expect(gauge.get({ status: 'success' })).toBe(0);
    });
  });
});
