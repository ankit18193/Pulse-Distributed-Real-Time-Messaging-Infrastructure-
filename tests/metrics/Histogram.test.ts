import { Histogram } from '../../src/metrics/Histogram.js';
import { DEFAULT_LATENCY_BUCKETS } from '../../src/metrics/types.js';

describe('Checkpoint 04: Cumulative Latency Histograms', () => {
  let histogram: Histogram;

  beforeEach(() => {
    histogram = new Histogram({
      name: 'pulse_message_processing_duration_seconds',
      help: 'Message processing latency in seconds'
    });
  });

  describe('Initialization and Bucket Structure', () => {
    it('uses the approved 11 latency buckets by default', () => {
      expect(histogram.buckets).toEqual(DEFAULT_LATENCY_BUCKETS);
      const val = histogram.getValue();
      expect(val.buckets).toHaveLength(DEFAULT_LATENCY_BUCKETS.length + 1); // 11 finite + 1 (+Inf)
      expect(val.count).toBe(0);
      expect(val.sum).toBe(0);

      // Verify final bucket is +Inf (Infinity)
      expect(val.buckets[val.buckets.length - 1].le).toBe(Infinity);
      expect(val.buckets[val.buckets.length - 1].count).toBe(0);
    });

    it('rejects invalid or non-positive bucket boundaries', () => {
      expect(() => {
        new Histogram({
          name: 'bad_histogram',
          help: 'help',
          buckets: [0.001, -0.005]
        });
      }).toThrow(/must be positive numbers/);

      expect(() => {
        new Histogram({
          name: 'bad_histogram',
          help: 'help',
          buckets: [0.001, 0.001]
        });
      }).toThrow(/Duplicate bucket boundary/);
    });
  });

  describe('Cumulative Bucket Placement', () => {
    it('correctly increments all cumulative buckets where le >= value', () => {
      // Record 0.0015s (1.5ms)
      // Should be in le >= 0.002, 0.005, 0.010 ... and +Inf
      // Should NOT be in le=0.0005 (0.5ms) or le=0.001 (1ms)
      histogram.record(0.0015);

      const val = histogram.getValue();
      expect(val.count).toBe(1);
      expect(val.sum).toBeCloseTo(0.0015, 6);

      const bucketMap = new Map(val.buckets.map((b) => [b.le, b.count]));
      expect(bucketMap.get(0.0005)).toBe(0);
      expect(bucketMap.get(0.001)).toBe(0);
      expect(bucketMap.get(0.002)).toBe(1);
      expect(bucketMap.get(0.005)).toBe(1);
      expect(bucketMap.get(0.010)).toBe(1);
      expect(bucketMap.get(0.025)).toBe(1);
      expect(bucketMap.get(0.050)).toBe(1);
      expect(bucketMap.get(0.100)).toBe(1);
      expect(bucketMap.get(0.250)).toBe(1);
      expect(bucketMap.get(0.500)).toBe(1);
      expect(bucketMap.get(1.000)).toBe(1);
      expect(bucketMap.get(Infinity)).toBe(1);
    });

    it('places multiple observations cumulatively', () => {
      // 1 sample in 0.5ms
      histogram.record(0.0004);
      // 1 sample in 1ms
      histogram.record(0.0008);
      // 1 sample in 5ms
      histogram.record(0.003);

      const val = histogram.getValue();
      expect(val.count).toBe(3);
      expect(val.sum).toBeCloseTo(0.0004 + 0.0008 + 0.003, 6);

      const bucketMap = new Map(val.buckets.map((b) => [b.le, b.count]));
      expect(bucketMap.get(0.0005)).toBe(1); // 0.0004
      expect(bucketMap.get(0.001)).toBe(2);  // 0.0004, 0.0008
      expect(bucketMap.get(0.002)).toBe(2);  // 0.0004, 0.0008
      expect(bucketMap.get(0.005)).toBe(3);  // 0.0004, 0.0008, 0.003
      expect(bucketMap.get(1.000)).toBe(3);
      expect(bucketMap.get(Infinity)).toBe(3);
    });

    it('handles observations larger than 1.0 second correctly (+Inf bucket)', () => {
      // Observation of 2.5 seconds (above max bucket 1.000)
      histogram.record(2.5);

      const val = histogram.getValue();
      expect(val.count).toBe(1);
      expect(val.sum).toBe(2.5);

      const bucketMap = new Map(val.buckets.map((b) => [b.le, b.count]));
      // None of the finite buckets should have count 1
      for (const le of DEFAULT_LATENCY_BUCKETS) {
        expect(bucketMap.get(le)).toBe(0);
      }
      // Only +Inf bucket is incremented
      expect(bucketMap.get(Infinity)).toBe(1);
    });

    it('clamps negative observation values to 0 without corrupting sum or buckets', () => {
      histogram.record(-0.05);

      const val = histogram.getValue();
      expect(val.count).toBe(1);
      expect(val.sum).toBe(0);

      const bucketMap = new Map(val.buckets.map((b) => [b.le, b.count]));
      // 0 <= all positive boundaries, so all buckets incremented
      expect(bucketMap.get(0.0005)).toBe(1);
      expect(bucketMap.get(Infinity)).toBe(1);
    });
  });

  describe('Labeled Histogram Series', () => {
    it('manages independent cumulative buckets per label set', () => {
      const labeledHist = new Histogram({
        name: 'pulse_redis_publish_duration_seconds',
        help: 'Redis publish duration by status',
        labelNames: ['status']
      });

      labeledHist.record(0.0008, { status: 'success' });
      labeledHist.record(0.050, { status: 'error' });

      const successVal = labeledHist.getValue({ status: 'success' });
      expect(successVal.count).toBe(1);
      expect(new Map(successVal.buckets.map((b) => [b.le, b.count])).get(0.001)).toBe(1);

      const errorVal = labeledHist.getValue({ status: 'error' });
      expect(errorVal.count).toBe(1);
      expect(new Map(errorVal.buckets.map((b) => [b.le, b.count])).get(0.001)).toBe(0);
      expect(new Map(errorVal.buckets.map((b) => [b.le, b.count])).get(0.050)).toBe(1);
    });

    it('enforces low-cardinality label rules on record', () => {
      const labeledHist = new Histogram({
        name: 'test_histogram',
        help: 'help',
        labelNames: ['status']
      });

      expect(() => {
        labeledHist.record(0.01, { roomId: 'secret-room' });
      }).toThrow(/Low-cardinality violation/);
    });
  });

  describe('Reset and Sample Collection', () => {
    it('resets cumulative bucket counts, sum, and count to zero', () => {
      histogram.record(0.002);
      histogram.record(0.05);

      expect(histogram.getValue().count).toBe(2);

      histogram.reset();
      const val = histogram.getValue();
      expect(val.count).toBe(0);
      expect(val.sum).toBe(0);
      for (const b of val.buckets) {
        expect(b.count).toBe(0);
      }
    });

    it('collects all bucket samples, +Inf sample, sum, and count in Prometheus structure', () => {
      histogram.record(0.001);

      const samples = histogram.collect();
      // 11 buckets + 1 (+Inf) + 1 (sum) + 1 (count) = 14 samples
      expect(samples).toHaveLength(14);

      const bucketSamples = samples.filter((s) => s.name.endsWith('_bucket'));
      expect(bucketSamples).toHaveLength(12);

      const infSample = bucketSamples.find((s) => s.labels?.le === '+Inf');
      expect(infSample).toBeDefined();
      expect(infSample?.value).toBe(1);

      const sumSample = samples.find((s) => s.name.endsWith('_sum'));
      expect(sumSample).toBeDefined();
      expect(sumSample?.value).toBeCloseTo(0.001, 6);

      const countSample = samples.find((s) => s.name.endsWith('_count'));
      expect(countSample).toBeDefined();
      expect(countSample?.value).toBe(1);
    });
  });
});
