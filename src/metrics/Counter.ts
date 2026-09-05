import {
  ICounter,
  MetricLabels,
  MetricSample,
  MetricType,
  assertLowCardinalityLabels
} from './types.js';

interface LabeledSeries {
  labels: MetricLabels;
  value: number;
}

export class Counter implements ICounter {
  public readonly name: string;
  public readonly help: string;
  public readonly type: MetricType = 'counter';
  public readonly labelNames: readonly string[];

  // Zero-allocation path for unlabelled metric
  private unlabelledValue: number = 0;

  // Pre-allocated storage for bounded label series
  private readonly series: Map<string, LabeledSeries> = new Map();

  constructor(options: {
    name: string;
    help: string;
    labelNames?: readonly string[];
  }) {
    if (!options.name || typeof options.name !== 'string') {
      throw new Error('Counter name must be a non-empty string');
    }
    this.name = options.name;
    this.help = options.help || '';
    this.labelNames = options.labelNames ? [...options.labelNames] : [];
  }

  /**
   * Monotonically increments counter by value (default 1).
   * Throws if value is negative.
   */
  public inc(labels?: MetricLabels, value: number = 1): void {
    if (typeof value !== 'number' || isNaN(value) || value < 0) {
      throw new Error(`Counter increment value must be a non-negative number; received ${value}`);
    }

    if (this.labelNames.length === 0) {
      this.unlabelledValue += value;
      return;
    }

    const key = this.resolveKey(labels);
    let entry = this.series.get(key);
    if (!entry) {
      assertLowCardinalityLabels(labels);
      entry = {
        labels: this.filterAllowedLabels(labels),
        value: 0
      };
      this.series.set(key, entry);
    }
    entry.value += value;
  }

  /**
   * Retrieves the current counter value for the given labels (or unlabeled value).
   */
  public get(labels?: MetricLabels): number {
    if (this.labelNames.length === 0) {
      return this.unlabelledValue;
    }
    const key = this.resolveKey(labels);
    const entry = this.series.get(key);
    return entry ? entry.value : 0;
  }

  /**
   * Resets counter to zero.
   */
  public reset(): void {
    this.unlabelledValue = 0;
    for (const entry of this.series.values()) {
      entry.value = 0;
    }
  }

  /**
   * Collects metric samples for serialization.
   */
  public collect(): MetricSample[] {
    if (this.labelNames.length === 0) {
      return [{ name: this.name, value: this.unlabelledValue }];
    }

    const samples: MetricSample[] = [];
    for (const entry of this.series.values()) {
      samples.push({
        name: this.name,
        labels: entry.labels,
        value: entry.value
      });
    }
    return samples;
  }

  private resolveKey(labels?: MetricLabels): string {
    if (!labels) {
      return '';
    }
    if (this.labelNames.length === 1) {
      const singleName = this.labelNames[0];
      return labels[singleName] || '';
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
