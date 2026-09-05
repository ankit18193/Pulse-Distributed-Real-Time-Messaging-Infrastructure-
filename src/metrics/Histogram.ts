import {
  IHistogram,
  HistogramValue,
  HistogramBucket,
  MetricLabels,
  MetricSample,
  MetricType,
  DEFAULT_LATENCY_BUCKETS,
  assertLowCardinalityLabels
} from './types.js';

interface HistogramSeries {
  labels: MetricLabels;
  bucketCounts: number[]; // length = buckets.length
  sum: number;
  count: number;
}

export class Histogram implements IHistogram {
  public readonly name: string;
  public readonly help: string;
  public readonly type: MetricType = 'histogram';
  public readonly labelNames: readonly string[];
  public readonly buckets: readonly number[];

  // Zero-allocation unlabelled series
  private readonly unlabelledSeries: HistogramSeries;

  // Labeled series map
  private readonly seriesMap: Map<string, HistogramSeries> = new Map();

  constructor(options: {
    name: string;
    help: string;
    labelNames?: readonly string[];
    buckets?: readonly number[];
  }) {
    if (!options.name || typeof options.name !== 'string') {
      throw new Error('Histogram name must be a non-empty string');
    }
    this.name = options.name;
    this.help = options.help || '';
    this.labelNames = options.labelNames ? [...options.labelNames] : [];

    // Sort buckets in ascending order and validate
    const rawBuckets = options.buckets ?? DEFAULT_LATENCY_BUCKETS;
    const sorted = [...rawBuckets].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      if (typeof sorted[i] !== 'number' || isNaN(sorted[i]) || sorted[i] <= 0) {
        throw new Error(`Histogram bucket boundaries must be positive numbers; received ${sorted[i]}`);
      }
      if (i > 0 && sorted[i] === sorted[i - 1]) {
        throw new Error(`Duplicate bucket boundary detected in histogram: ${sorted[i]}`);
      }
    }
    this.buckets = sorted;

    this.unlabelledSeries = {
      labels: {},
      bucketCounts: new Array(this.buckets.length).fill(0),
      sum: 0,
      count: 0
    };
  }

  /**
   * Records an observation value into the cumulative histogram.
   * Standard Prometheus semantics: every bucket with le >= value is incremented.
   */
  public record(value: number, labels?: MetricLabels): void {
    if (typeof value !== 'number' || isNaN(value)) {
      throw new Error(`Histogram observation value must be a valid number; received ${value}`);
    }

    // Negative observations in duration histograms are clamped to zero
    const val = value < 0 ? 0 : value;

    const series = this.getOrCreateSeries(labels);
    series.count++;
    series.sum += val;

    // Cumulative bucket placement: all buckets where val <= le are incremented
    for (let i = 0; i < this.buckets.length; i++) {
      if (val <= this.buckets[i]) {
        series.bucketCounts[i]++;
      }
    }
  }

  /**
   * Retrieves the cumulative bucket counts, sum, and count for given labels.
   */
  public getValue(labels?: MetricLabels): HistogramValue {
    const series = this.getSeries(labels);
    if (!series) {
      return {
        buckets: this.buildBuckets(new Array(this.buckets.length).fill(0), 0),
        sum: 0,
        count: 0
      };
    }

    return {
      buckets: this.buildBuckets(series.bucketCounts, series.count),
      sum: series.sum,
      count: series.count
    };
  }

  /**
   * Resets all histogram observations to zero.
   */
  public reset(): void {
    this.unlabelledSeries.bucketCounts.fill(0);
    this.unlabelledSeries.sum = 0;
    this.unlabelledSeries.count = 0;

    for (const s of this.seriesMap.values()) {
      s.bucketCounts.fill(0);
      s.sum = 0;
      s.count = 0;
    }
  }

  /**
   * Collects all metric samples (sum, count, buckets) for serialization.
   */
  public collect(): MetricSample[] {
    const allSeries =
      this.labelNames.length === 0
        ? [this.unlabelledSeries]
        : Array.from(this.seriesMap.values());

    const samples: MetricSample[] = [];

    for (const s of allSeries) {
      // 1. Bucket samples
      for (let i = 0; i < this.buckets.length; i++) {
        samples.push({
          name: `${this.name}_bucket`,
          labels: { ...s.labels, le: String(this.buckets[i]) },
          value: s.bucketCounts[i]
        });
      }

      // 2. +Inf bucket
      samples.push({
        name: `${this.name}_bucket`,
        labels: { ...s.labels, le: '+Inf' },
        value: s.count
      });

      // 3. Sum and Count
      samples.push({
        name: `${this.name}_sum`,
        labels: s.labels,
        value: s.sum
      });

      samples.push({
        name: `${this.name}_count`,
        labels: s.labels,
        value: s.count
      });
    }

    return samples;
  }

  private buildBuckets(bucketCounts: number[], totalCount: number): HistogramBucket[] {
    const result: HistogramBucket[] = [];
    for (let i = 0; i < this.buckets.length; i++) {
      result.push({
        le: this.buckets[i],
        count: bucketCounts[i]
      });
    }
    // Final cumulative +Inf bucket
    result.push({
      le: Infinity,
      count: totalCount
    });
    return result;
  }

  private getOrCreateSeries(labels?: MetricLabels): HistogramSeries {
    if (this.labelNames.length === 0) {
      return this.unlabelledSeries;
    }

    const key = this.resolveKey(labels);
    let series = this.seriesMap.get(key);
    if (!series) {
      assertLowCardinalityLabels(labels);
      series = {
        labels: this.filterAllowedLabels(labels),
        bucketCounts: new Array(this.buckets.length).fill(0),
        sum: 0,
        count: 0
      };
      this.seriesMap.set(key, series);
    }
    return series;
  }

  private getSeries(labels?: MetricLabels): HistogramSeries | undefined {
    if (this.labelNames.length === 0) {
      return this.unlabelledSeries;
    }
    const key = this.resolveKey(labels);
    return this.seriesMap.get(key);
  }

  private resolveKey(labels?: MetricLabels): string {
    if (!labels) {
      return '';
    }
    if (this.labelNames.length === 1) {
      return labels[this.labelNames[0]] || '';
    }
    const parts: string[] = [];
    for (const name of this.labelNames) {
      parts.push(`${name}=${labels[name] ?? ''}`);
    }
    return parts.join('|');
  }

  private filterAllowedLabels(labels?: MetricLabels): MetricLabels {
    const filtered: MetricLabels = {};
    if (!labels) {
      return filtered;
    }
    for (const name of this.labelNames) {
      if (labels[name] !== undefined) {
        filtered[name] = labels[name];
      }
    }
    return filtered;
  }
}
