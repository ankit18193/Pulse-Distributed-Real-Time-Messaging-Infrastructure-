import {
  IMetric,
  ICounter,
  IGauge,
  IHistogram
} from './types.js';

export class PulseMetricsRegistry {
  private readonly metrics: Map<string, IMetric> = new Map();

  /**
   * Registers a metric in the registry.
   * Throws an error if a metric with the same name is already registered.
   */
  public register(metric: IMetric): void {
    if (!metric || !metric.name) {
      throw new Error('Cannot register invalid metric without a name');
    }

    if (this.metrics.has(metric.name)) {
      throw new Error(`Metric with name "${metric.name}" is already registered.`);
    }

    this.metrics.set(metric.name, metric);
  }

  /**
   * Fast O(1) lookup of a metric by name.
   */
  public getMetric<T extends IMetric = IMetric>(name: string): T | undefined {
    return this.metrics.get(name) as T | undefined;
  }

  /**
   * Fast O(1) lookup of a Counter metric by name.
   */
  public getCounter(name: string): ICounter | undefined {
    const metric = this.metrics.get(name);
    if (!metric) {
      return undefined;
    }
    if (metric.type !== 'counter') {
      throw new Error(
        `Metric "${name}" was requested as counter but is registered as ${metric.type}`
      );
    }
    return metric as ICounter;
  }

  /**
   * Fast O(1) lookup of a Gauge metric by name.
   */
  public getGauge(name: string): IGauge | undefined {
    const metric = this.metrics.get(name);
    if (!metric) {
      return undefined;
    }
    if (metric.type !== 'gauge') {
      throw new Error(
        `Metric "${name}" was requested as gauge but is registered as ${metric.type}`
      );
    }
    return metric as IGauge;
  }

  /**
   * Fast O(1) lookup of a Histogram metric by name.
   */
  public getHistogram(name: string): IHistogram | undefined {
    const metric = this.metrics.get(name);
    if (!metric) {
      return undefined;
    }
    if (metric.type !== 'histogram') {
      throw new Error(
        `Metric "${name}" was requested as histogram but is registered as ${metric.type}`
      );
    }
    return metric as IHistogram;
  }

  /**
   * Checks whether a metric with the given name is registered.
   */
  public has(name: string): boolean {
    return this.metrics.has(name);
  }

  /**
   * Returns all registered metrics.
   */
  public getAll(): IMetric[] {
    return Array.from(this.metrics.values());
  }

  /**
   * Returns total count of registered metrics.
   */
  public getCount(): number {
    return this.metrics.size;
  }

  /**
   * Resets all registered metrics to their initial states.
   */
  public resetAll(): void {
    for (const metric of this.metrics.values()) {
      metric.reset();
    }
  }

  /**
   * Clears all metrics from the registry.
   */
  public clear(): void {
    this.metrics.clear();
  }
}
