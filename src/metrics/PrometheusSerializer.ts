import { PulseMetricsRegistry } from './PulseMetricsRegistry.js';
import { IMetric, MetricLabels } from './types.js';
import { Histogram } from './Histogram.js';

export class PrometheusSerializer {
  /**
   * Serializes all metrics in the registry into deterministic Prometheus 0.0.4 text exposition format.
   */
  public static serialize(registry: PulseMetricsRegistry): string {
    const metrics = registry.getAll();
    if (metrics.length === 0) {
      return '';
    }

    // Sort metrics deterministically by name
    const sortedMetrics = [...metrics].sort((a, b) => a.name.localeCompare(b.name));
    const lines: string[] = [];

    for (const metric of sortedMetrics) {
      this.serializeMetric(metric, lines);
    }

    // Prometheus text format MUST terminate with a trailing newline
    return lines.join('\n') + '\n';
  }

  private static serializeMetric(metric: IMetric, lines: string[]): void {
    // 1. HELP line
    if (metric.help) {
      lines.push(`# HELP ${metric.name} ${this.escapeHelp(metric.help)}`);
    }

    // 2. TYPE line
    lines.push(`# TYPE ${metric.name} ${metric.type}`);

    // 3. Metric samples
    if (metric.type === 'histogram' && metric instanceof Histogram) {
      this.serializeHistogram(metric, lines);
    } else {
      const samples = metric.collect();
      for (const sample of samples) {
        const labelStr = this.formatLabels(sample.labels);
        lines.push(`${sample.name}${labelStr} ${this.formatValue(sample.value)}`);
      }
    }
  }

  private static serializeHistogram(histogram: Histogram, lines: string[]): void {
    const samples = histogram.collect();

    // Separate samples into buckets, sums, and counts
    // Histogram samples from histogram.collect() already provide:
    // _bucket{..., le="..."}, _sum, and _count
    for (const sample of samples) {
      const labelStr = this.formatLabels(sample.labels);
      lines.push(`${sample.name}${labelStr} ${this.formatValue(sample.value)}`);
    }
  }

  public static formatLabels(labels?: MetricLabels): string {
    if (!labels || Object.keys(labels).length === 0) {
      return '';
    }

    // Sort labels deterministically by key name
    const keys = Object.keys(labels).sort();
    const formattedPairs: string[] = [];

    for (const key of keys) {
      const val = labels[key];
      if (val !== undefined) {
        formattedPairs.push(`${key}="${this.escapeLabelValue(String(val))}"`);
      }
    }

    return `{${formattedPairs.join(',')}}`;
  }

  public static formatValue(value: number): string {
    if (Number.isInteger(value)) {
      return String(value);
    }
    if (value === Infinity) {
      return '+Inf';
    }
    if (value === -Infinity) {
      return '-Inf';
    }
    if (isNaN(value)) {
      return 'NaN';
    }
    // Limit floating point representation to 6 decimal places to prevent float precision noise
    const str = value.toString();
    if (str.includes('e')) {
      return value.toFixed(6);
    }
    return str;
  }

  private static escapeHelp(text: string): string {
    return text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
  }

  public static escapeLabelValue(text: string): string {
    return text
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');
  }
}
