import { PulseMetricsRegistry } from '../../src/metrics/PulseMetricsRegistry.js';
import { Counter } from '../../src/metrics/Counter.js';
import { Gauge } from '../../src/metrics/Gauge.js';
import { Histogram } from '../../src/metrics/Histogram.js';
import { PrometheusSerializer } from '../../src/metrics/PrometheusSerializer.js';

describe('Checkpoint 05: Prometheus Metrics Serialization', () => {
  let registry: PulseMetricsRegistry;

  beforeEach(() => {
    registry = new PulseMetricsRegistry();
  });

  it('returns empty string when registry has no metrics', () => {
    expect(PrometheusSerializer.serialize(registry)).toBe('');
  });

  it('serializes counter with HELP, TYPE, and samples', () => {
    const counter = new Counter({
      name: 'pulse_messages_total',
      help: 'Total messages received'
    });
    counter.inc(undefined, 42);
    registry.register(counter);

    const output = PrometheusSerializer.serialize(registry);
    const expected = [
      '# HELP pulse_messages_total Total messages received',
      '# TYPE pulse_messages_total counter',
      'pulse_messages_total 42',
      ''
    ].join('\n');

    expect(output).toBe(expected);
  });

  it('serializes gauge with HELP, TYPE, and samples', () => {
    const gauge = new Gauge({
      name: 'pulse_connections_active',
      help: 'Current active connections'
    });
    gauge.set(15);
    registry.register(gauge);

    const output = PrometheusSerializer.serialize(registry);
    const expected = [
      '# HELP pulse_connections_active Current active connections',
      '# TYPE pulse_connections_active gauge',
      'pulse_connections_active 15',
      ''
    ].join('\n');

    expect(output).toBe(expected);
  });

  it('serializes labeled metrics with deterministically sorted labels', () => {
    const counter = new Counter({
      name: 'pulse_requests_total',
      help: 'Request counter',
      labelNames: ['status', 'event_type']
    });

    // Inverted insertion order to test deterministic sorting
    counter.inc({ status: 'success', event_type: 'ROOM_MESSAGE' }, 10);
    registry.register(counter);

    const output = PrometheusSerializer.serialize(registry);
    // Labels should be sorted alphabetically: event_type before status
    expect(output).toContain(
      'pulse_requests_total{event_type="ROOM_MESSAGE",status="success"} 10'
    );
  });

  it('serializes histogram with all buckets, sum, and count', () => {
    const histogram = new Histogram({
      name: 'pulse_dispatch_duration_seconds',
      help: 'Dispatch duration',
      buckets: [0.001, 0.005, 0.010]
    });
    histogram.record(0.002);
    registry.register(histogram);

    const output = PrometheusSerializer.serialize(registry);
    expect(output).toContain('# HELP pulse_dispatch_duration_seconds Dispatch duration');
    expect(output).toContain('# TYPE pulse_dispatch_duration_seconds histogram');
    expect(output).toContain('pulse_dispatch_duration_seconds_bucket{le="0.001"} 0');
    expect(output).toContain('pulse_dispatch_duration_seconds_bucket{le="0.005"} 1');
    expect(output).toContain('pulse_dispatch_duration_seconds_bucket{le="0.01"} 1');
    expect(output).toContain('pulse_dispatch_duration_seconds_bucket{le="+Inf"} 1');
    expect(output).toContain('pulse_dispatch_duration_seconds_sum 0.002');
    expect(output).toContain('pulse_dispatch_duration_seconds_count 1');
  });

  it('sorts metrics deterministically in alphabetical order', () => {
    const metricZ = new Counter({ name: 'z_metric', help: 'Z metric' });
    const metricA = new Gauge({ name: 'a_metric', help: 'A metric' });
    const metricM = new Counter({ name: 'm_metric', help: 'M metric' });

    registry.register(metricZ);
    registry.register(metricA);
    registry.register(metricM);

    const output = PrometheusSerializer.serialize(registry);
    const posA = output.indexOf('a_metric');
    const posM = output.indexOf('m_metric');
    const posZ = output.indexOf('z_metric');

    expect(posA).toBeLessThan(posM);
    expect(posM).toBeLessThan(posZ);
  });

  it('escapes special characters in help strings and label values', () => {
    const counter = new Counter({
      name: 'pulse_escaped_total',
      help: 'Line 1\nLine 2 with "quotes" and \\backslashes\\',
      labelNames: ['reason']
    });
    counter.inc({ reason: 'quote"and\\slash\nnewline' });
    registry.register(counter);

    const output = PrometheusSerializer.serialize(registry);
    expect(output).toContain('# HELP pulse_escaped_total Line 1\\nLine 2 with "quotes" and \\\\backslashes\\\\');
    expect(output).toContain('reason="quote\\"and\\\\slash\\nnewline"');
  });

  it('always terminates with a trailing newline', () => {
    const counter = new Counter({ name: 'c1', help: 'c1 help' });
    counter.inc();
    registry.register(counter);

    const output = PrometheusSerializer.serialize(registry);
    expect(output.endsWith('\n')).toBe(true);
  });
});
