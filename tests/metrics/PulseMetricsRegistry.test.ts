import { PulseMetricsRegistry } from '../../src/metrics/PulseMetricsRegistry.js';
import { ICounter, IGauge, IHistogram, MetricSample, HistogramValue } from '../../src/metrics/types.js';

describe('Checkpoint 02: PulseMetricsRegistry', () => {
  let registry: PulseMetricsRegistry;

  beforeEach(() => {
    registry = new PulseMetricsRegistry();
  });

  const createMockCounter = (name: string): ICounter => ({
    name,
    help: `${name} help text`,
    type: 'counter',
    labelNames: ['status'],
    inc: jest.fn(),
    get: jest.fn().mockReturnValue(0),
    reset: jest.fn(),
    collect: jest.fn().mockReturnValue([])
  });

  const createMockGauge = (name: string): IGauge => ({
    name,
    help: `${name} help text`,
    type: 'gauge',
    labelNames: [],
    set: jest.fn(),
    inc: jest.fn(),
    dec: jest.fn(),
    get: jest.fn().mockReturnValue(0),
    reset: jest.fn(),
    collect: jest.fn().mockReturnValue([])
  });

  const createMockHistogram = (name: string): IHistogram => ({
    name,
    help: `${name} help text`,
    type: 'histogram',
    labelNames: [],
    record: jest.fn(),
    getValue: jest.fn().mockReturnValue({ buckets: [], sum: 0, count: 0 } as HistogramValue),
    reset: jest.fn(),
    collect: jest.fn().mockReturnValue([])
  });

  describe('Registration and Duplicate Protection', () => {
    it('successfully registers counter, gauge, and histogram metrics', () => {
      const counter = createMockCounter('pulse_messages_total');
      const gauge = createMockGauge('pulse_connections_active');
      const histogram = createMockHistogram('pulse_latency_seconds');

      registry.register(counter);
      registry.register(gauge);
      registry.register(histogram);

      expect(registry.getCount()).toBe(3);
      expect(registry.has('pulse_messages_total')).toBe(true);
      expect(registry.has('pulse_connections_active')).toBe(true);
      expect(registry.has('pulse_latency_seconds')).toBe(true);
      expect(registry.has('non_existent')).toBe(false);
    });

    it('throws when attempting to register a duplicate metric name', () => {
      const counter1 = createMockCounter('pulse_connections_total');
      const counter2 = createMockCounter('pulse_connections_total');

      registry.register(counter1);
      expect(() => {
        registry.register(counter2);
      }).toThrow(/already registered/);
    });

    it('throws when registering invalid metric', () => {
      expect(() => {
        registry.register(null as any);
      }).toThrow(/invalid metric/);

      expect(() => {
        registry.register({ name: '' } as any);
      }).toThrow(/invalid metric/);
    });
  });

  describe('O(1) Metric Lookup and Type Verification', () => {
    it('retrieves typed counter, gauge, and histogram', () => {
      const counter = createMockCounter('test_counter');
      const gauge = createMockGauge('test_gauge');
      const histogram = createMockHistogram('test_histogram');

      registry.register(counter);
      registry.register(gauge);
      registry.register(histogram);

      expect(registry.getCounter('test_counter')).toBe(counter);
      expect(registry.getGauge('test_gauge')).toBe(gauge);
      expect(registry.getHistogram('test_histogram')).toBe(histogram);
      expect(registry.getMetric('test_counter')).toBe(counter);
    });

    it('returns undefined for non-existent metrics', () => {
      expect(registry.getCounter('missing')).toBeUndefined();
      expect(registry.getGauge('missing')).toBeUndefined();
      expect(registry.getHistogram('missing')).toBeUndefined();
      expect(registry.getMetric('missing')).toBeUndefined();
    });

    it('enforces type mismatch protections on lookups', () => {
      const counter = createMockCounter('confused_metric');
      registry.register(counter);

      expect(() => {
        registry.getGauge('confused_metric');
      }).toThrow(/requested as gauge but is registered as counter/);

      expect(() => {
        registry.getHistogram('confused_metric');
      }).toThrow(/requested as histogram but is registered as counter/);
    });
  });

  describe('Lifecycle and Teardown Support', () => {
    it('resets all registered metrics when resetAll() is called', () => {
      const counter = createMockCounter('c1');
      const gauge = createMockGauge('g1');
      const histogram = createMockHistogram('h1');

      registry.register(counter);
      registry.register(gauge);
      registry.register(histogram);

      registry.resetAll();

      expect(counter.reset).toHaveBeenCalledTimes(1);
      expect(gauge.reset).toHaveBeenCalledTimes(1);
      expect(histogram.reset).toHaveBeenCalledTimes(1);
    });

    it('clears all metrics when clear() is called', () => {
      registry.register(createMockCounter('c1'));
      registry.register(createMockGauge('g1'));

      expect(registry.getCount()).toBe(2);
      registry.clear();
      expect(registry.getCount()).toBe(0);
      expect(registry.getAll()).toEqual([]);
    });

    it('returns array of all registered metrics via getAll()', () => {
      const counter = createMockCounter('c1');
      const gauge = createMockGauge('g1');

      registry.register(counter);
      registry.register(gauge);

      const all = registry.getAll();
      expect(all).toHaveLength(2);
      expect(all).toContain(counter);
      expect(all).toContain(gauge);
    });
  });
});
