/**
 * Pulse — Distributed Real-Time Messaging Infrastructure
 * Empirical Benchmark Statistics Aggregator
 */

import { BenchmarkConfig, BenchmarkResult, PercentileStats } from './types.js';

export class StatsAggregator {
  private readonly config: BenchmarkConfig;
  private readonly startTimeMs: number;
  private endTimeMs: number = 0;

  private connectionsAttempted: number = 0;
  private connectionsEstablished: number = 0;
  private connectionsFailed: number = 0;

  private messagesSent: number = 0;
  private messagesReceived: number = 0;
  private messagesDropped: number = 0;

  private readonly latenciesMs: number[] = [];
  private readonly connectLatenciesMs: number[] = [];
  private readonly errors: string[] = [];

  constructor(config: BenchmarkConfig) {
    this.config = config;
    this.startTimeMs = Date.now();
  }

  public recordConnectionAttempt(): void {
    this.connectionsAttempted++;
  }

  public recordConnectionSuccess(latencyMs?: number): void {
    this.connectionsEstablished++;
    if (typeof latencyMs === 'number' && Number.isFinite(latencyMs)) {
      this.connectLatenciesMs.push(Math.max(0, latencyMs));
    }
  }

  public recordConnectionFailure(error?: string): void {
    this.connectionsFailed++;
    if (error && !this.errors.includes(error)) {
      this.errors.push(error);
    }
  }

  public recordSent(count: number = 1): void {
    this.messagesSent += count;
  }

  public recordReceived(count: number = 1, latencyMs?: number): void {
    this.messagesReceived += count;
    if (typeof latencyMs === 'number' && Number.isFinite(latencyMs)) {
      this.latenciesMs.push(Math.max(0, latencyMs));
    }
  }

  public recordDropped(count: number = 1): void {
    this.messagesDropped += count;
  }

  public recordLatency(latencyMs: number): void {
    if (Number.isFinite(latencyMs)) {
      this.latenciesMs.push(Math.max(0, latencyMs));
    }
  }

  public recordError(error: string): void {
    if (error && !this.errors.includes(error)) {
      this.errors.push(error);
    }
  }

  public finish(): void {
    this.endTimeMs = Date.now();
  }

  public static calculatePercentiles(samples: number[]): PercentileStats {
    if (samples.length === 0) {
      return {
        minMs: 0,
        maxMs: 0,
        meanMs: 0,
        p50Ms: 0,
        p90Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        count: 0
      };
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const count = sorted.length;
    let sum = 0;
    for (let i = 0; i < count; i++) {
      sum += sorted[i];
    }
    const meanMs = Math.round((sum / count) * 100) / 100;
    const minMs = Math.round(sorted[0] * 100) / 100;
    const maxMs = Math.round(sorted[count - 1] * 100) / 100;

    const getPercentile = (p: number): number => {
      if (count === 1) return sorted[0];
      const index = (p / 100) * (count - 1);
      const lower = Math.floor(index);
      const upper = Math.ceil(index);
      const weight = index - lower;
      const value = sorted[lower] * (1 - weight) + sorted[upper] * weight;
      return Math.round(value * 100) / 100;
    };

    return {
      minMs,
      maxMs,
      meanMs,
      p50Ms: getPercentile(50),
      p90Ms: getPercentile(90),
      p95Ms: getPercentile(95),
      p99Ms: getPercentile(99),
      count
    };
  }

  public computeResult(): BenchmarkResult {
    if (this.endTimeMs === 0) {
      this.endTimeMs = Date.now();
    }

    const durationSec = Math.max(0.001, (this.endTimeMs - this.startTimeMs) / 1000);
    const latencyStats = StatsAggregator.calculatePercentiles(this.latenciesMs);
    const connectLatencyStats = StatsAggregator.calculatePercentiles(this.connectLatenciesMs);

    const throughputMsgPerSec = Math.round((this.messagesReceived / durationSec) * 10) / 10;
    const totalExpected = this.messagesSent;
    const deliveryRatePercent =
      totalExpected > 0
        ? Math.min(100, Math.round((this.messagesReceived / totalExpected) * 10000) / 100)
        : this.messagesReceived > 0
          ? 100
          : 100;

    const slaViolations: string[] = [];

    // Check connection establishment SLA (no more than 5% connection failures)
    if (this.connectionsAttempted > 0 && this.connectionsFailed / this.connectionsAttempted > 0.05) {
      slaViolations.push(
        `Connection failure rate (${((this.connectionsFailed / this.connectionsAttempted) * 100).toFixed(1)}%) exceeded 5% threshold`
      );
    }

    // Check p95 latency SLA if samples exist (conservative 100ms threshold for overall benchmark runs)
    if (latencyStats.count > 0 && latencyStats.p95Ms > 100) {
      slaViolations.push(`p95 latency (${latencyStats.p95Ms}ms) exceeded 100ms threshold`);
    }

    const passed = slaViolations.length === 0 && this.connectionsFailed === 0;

    return {
      profile: this.config.profile,
      target: this.config.target,
      durationSec: Math.round(durationSec * 10) / 10,
      connectionsAttempted: this.connectionsAttempted,
      connectionsEstablished: this.connectionsEstablished,
      connectionsFailed: this.connectionsFailed,
      messagesSent: this.messagesSent,
      messagesReceived: this.messagesReceived,
      messagesDropped: this.messagesDropped,
      deliveryRatePercent,
      throughputMsgPerSec,
      latency: latencyStats,
      connectLatency: connectLatencyStats,
      errors: [...this.errors],
      passed,
      slaViolations
    };
  }
}
