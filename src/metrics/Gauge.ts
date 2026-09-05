import {
  IGauge,
  MetricLabels,
  MetricSample,
  MetricType,
  assertLowCardinalityLabels
} from './types.js';

interface LabeledSeries {
  labels: MetricLabels;
  value: number;
}

export class Gauge implements IGauge {
  public readonly name: string;
  public readonly help: string;
  public readonly type: MetricType = 'gauge';
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
      throw new Error('Gauge name must be a non-empty string');
    }
    this.name = options.name;
    this.help = options.help || '';
    this.labelNames = options.labelNames ? [...options.labelNames] : [];
  }

  /**
   * Sets the gauge to an arbitrary numeric value.
   */
  public set(value: number, labels?: MetricLabels): void {
    if (typeof value !== 'number' || isNaN(value)) {
      throw new Error(`Gauge value must be a valid number; received ${value}`);
    }

    if (this.labelNames.length === 0) {
      this.unlabelledValue = value;
      return;
    }

    const entry = this.getOrCreateEntry(labels);
    entry.value = value;
  }

  /**
   * Increments gauge by value (default 1).
   */
  public inc(labels?: MetricLabels, value: number = 1): void {
    if (typeof value !== 'number' || isNaN(value)) {
      throw new Error(`Gauge increment value must be a valid number; received ${value}`);
    }

    if (this.labelNames.length === 0) {
      this.unlabelledValue += value;
      return;
    }

    const entry = this.getOrCreateEntry(labels);
    entry.value += value;
  }

  /**
   * Decrements gauge by value (default 1).
   */
  public dec(labels?: MetricLabels, value: number = 1): void {
    if (typeof value !== 'number' || isNaN(value)) {
      throw new Error(`Gauge decrement value must be a valid number; received ${value}`);
    }

    if (this.labelNames.length === 0) {
      this.unlabelledValue -= value;
      return;
    }

    const entry = this.getOrCreateEntry(labels);
    entry.value -= value;
  }

  /**
   * Retrieves the current gauge value for the given labels (or unlabeled value).
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
   * Resets gauge to zero.
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

  private getOrCreateEntry(labels?: MetricLabels): LabeledSeries {
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
    return entry;
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
