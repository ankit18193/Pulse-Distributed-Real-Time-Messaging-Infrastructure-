/**
 * Pulse — Distributed Real-Time Messaging Infrastructure
 * Node.js Event-Loop Lag Monitoring via perf_hooks.monitorEventLoopDelay
 */

import { monitorEventLoopDelay, IntervalHistogram } from 'perf_hooks';

export interface EventLoopMetrics {
  meanSec: number;
  p50Sec: number;
  p99Sec: number;
  maxSec: number;
}

export class EventLoopMonitor {
  private histogram: IntervalHistogram | null = null;
  private isRunning: boolean = false;

  /**
   * Starts monitoring the Node.js event-loop delay.
   * @param resolutionMs Sampling resolution in milliseconds (default: 20ms)
   */
  public start(resolutionMs: number = 20): void {
    if (this.isRunning && this.histogram) {
      return;
    }
    this.histogram = monitorEventLoopDelay({ resolution: resolutionMs });
    this.histogram.enable();
    this.isRunning = true;
  }

  /**
   * Resets the underlying delay histogram.
   */
  public reset(): void {
    if (this.histogram) {
      this.histogram.reset();
    }
  }

  /**
   * Disables and releases the underlying event loop delay histogram.
   */
  public stop(): void {
    if (this.histogram) {
      this.histogram.disable();
      this.histogram = null;
    }
    this.isRunning = false;
  }

  /**
   * Returns whether the monitor is currently running.
   */
  public isActive(): boolean {
    return this.isRunning && this.histogram !== null;
  }

  /**
   * Retrieves the current event-loop delay metrics converted from nanoseconds to seconds.
   */
  public getMetrics(): EventLoopMetrics {
    if (!this.histogram) {
      return { meanSec: 0, p50Sec: 0, p99Sec: 0, maxSec: 0 };
    }

    // perf_hooks.monitorEventLoopDelay records values in nanoseconds.
    // Convert nanoseconds to seconds (1e9 ns = 1 s).
    const meanSec = (this.histogram.mean || 0) / 1e9;
    const p50Sec = (this.histogram.percentile(50) || 0) / 1e9;
    const p99Sec = (this.histogram.percentile(99) || 0) / 1e9;
    const maxSec = (this.histogram.max || 0) / 1e9;

    return {
      meanSec: isNaN(meanSec) ? 0 : meanSec,
      p50Sec: isNaN(p50Sec) ? 0 : p50Sec,
      p99Sec: isNaN(p99Sec) ? 0 : p99Sec,
      maxSec: isNaN(maxSec) ? 0 : maxSec
    };
  }
}
