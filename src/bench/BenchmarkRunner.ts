/**
 * Pulse — Distributed Real-Time Messaging Infrastructure
 * Empirical Benchmark Runner & Profile Coordinator
 */

import { WebSocket } from 'ws';
import { Authenticator } from '../auth/Authenticator.js';
import { StatsAggregator } from './StatsAggregator.js';
import { BenchmarkConfig, BenchmarkProfile, BenchmarkResult } from './types.js';
import { RampProfile } from './profiles/RampProfile.js';
import { BroadcastProfile } from './profiles/BroadcastProfile.js';
import { DirectProfile } from './profiles/DirectProfile.js';
import { BackpressureProfile } from './profiles/BackpressureProfile.js';
import { PresenceChurnProfile } from './profiles/PresenceChurnProfile.js';

export const SAFE_MAX_CONNECTIONS = 5000;
export const DEFAULT_AUTH_SECRET = 'dev-secret-key-pulse-messaging-jwt';

export class BenchmarkRunner {
  private readonly config: BenchmarkConfig;
  private readonly aggregator: StatsAggregator;
  private readonly activeSockets: Set<WebSocket> = new Set();
  private isAborted: boolean = false;

  constructor(config: Partial<BenchmarkConfig> = {}) {
    this.config = BenchmarkRunner.validateConfig(config);
    this.aggregator = new StatsAggregator(this.config);
  }

  public getConfig(): BenchmarkConfig {
    return { ...this.config };
  }

  public static validateConfig(partial: Partial<BenchmarkConfig>): BenchmarkConfig {
    const target = partial.target || 'ws://localhost:8080';
    if (!target.startsWith('ws://') && !target.startsWith('wss://')) {
      throw new Error(`Invalid benchmark target URL '${target}'. Must start with ws:// or wss://`);
    }

    const validProfiles: BenchmarkProfile[] = ['broadcast', 'direct', 'presence', 'ramp', 'backpressure'];
    const profile = partial.profile || 'broadcast';
    if (!validProfiles.includes(profile)) {
      throw new Error(
        `Unknown benchmark profile '${profile}'. Valid profiles are: ${validProfiles.join(', ')}`
      );
    }

    const forceHighConcurrency = partial.forceHighConcurrency === true;
    const connections = typeof partial.connections === 'number' ? partial.connections : 50;
    if (connections <= 0) {
      throw new Error(`Connections count must be greater than 0, received ${connections}`);
    }
    if (connections > SAFE_MAX_CONNECTIONS && !forceHighConcurrency) {
      throw new Error(
        `Requested ${connections} connections exceeds safe limit of ${SAFE_MAX_CONNECTIONS}. ` +
          `Use --force-high-concurrency to override this laptop safety threshold.`
      );
    }

    const durationSec = typeof partial.durationSec === 'number' ? partial.durationSec : 5;
    if (durationSec <= 0 || durationSec > 3600) {
      throw new Error(`Duration must be between 1 and 3600 seconds, received ${durationSec}`);
    }

    const rampRate = typeof partial.rampRate === 'number' ? partial.rampRate : 25;
    if (rampRate <= 0) {
      throw new Error(`Ramp rate must be greater than 0, received ${rampRate}`);
    }

    const messageRate = typeof partial.messageRate === 'number' ? partial.messageRate : 10;
    const rooms = typeof partial.rooms === 'number' ? partial.rooms : 5;
    const authSecret = partial.authSecret || DEFAULT_AUTH_SECRET;
    const json = partial.json === true;

    return {
      target,
      profile,
      connections,
      durationSec,
      rampRate,
      messageRate,
      rooms,
      authSecret,
      json,
      forceHighConcurrency
    };
  }

  public createClientToken(userId: string): string {
    const auth = new Authenticator(this.config.authSecret);
    return auth.generateToken({
      userId,
      roles: ['user'],
      expiresInMs: (this.config.durationSec + 60) * 1000
    });
  }

  public createAuthenticatedUrl(userId: string): string {
    const token = this.createClientToken(userId);
    const separator = this.config.target.includes('?') ? '&' : '?';
    return `${this.config.target}${separator}token=${encodeURIComponent(token)}`;
  }

  public connectClient(userId: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      if (this.isAborted) {
        return reject(new Error('Benchmark aborted'));
      }

      this.aggregator.recordConnectionAttempt();
      const startHr = process.hrtime.bigint();
      const url = this.createAuthenticatedUrl(userId);

      const ws = new WebSocket(url);

      const onOpen = () => {
        const latencyMs = Number(process.hrtime.bigint() - startHr) / 1e6;
        this.activeSockets.add(ws);
        this.aggregator.recordConnectionSuccess(latencyMs);
        ws.removeListener('error', onError);
        resolve(ws);
      };

      const onError = (err: Error) => {
        this.aggregator.recordConnectionFailure(err.message);
        ws.removeListener('open', onOpen);
        reject(err);
      };

      ws.once('open', onOpen);
      ws.once('error', onError);
    });
  }

  public abort(): void {
    this.isAborted = true;
    this.cleanup();
  }

  public cleanup(): void {
    for (const ws of this.activeSockets) {
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1000, 'Benchmark completed');
        }
      } catch {
        // Ignore socket teardown errors
      }
    }
    this.activeSockets.clear();
  }

  public async run(): Promise<BenchmarkResult> {
    try {
      switch (this.config.profile) {
        case 'ramp':
          await this.runRampWorkload();
          break;
        case 'broadcast': {
          const profile = new BroadcastProfile(this.config, this.aggregator);
          await profile.execute();
          break;
        }
        case 'direct': {
          const profile = new DirectProfile(this.config, this.aggregator);
          await profile.execute();
          break;
        }
        case 'backpressure': {
          const profile = new BackpressureProfile(this.config, this.aggregator);
          try {
            await profile.execute();
          } finally {
            await profile.cleanup();
          }
          break;
        }
        case 'presence': {
          const profile = new PresenceChurnProfile(this.config, this.aggregator);
          try {
            await profile.execute();
          } finally {
            profile.cleanup();
          }
          break;
        }
        default:
          await this.runBasicWorkload();
          break;
      }
    } catch (err) {
      this.aggregator.recordError(err instanceof Error ? err.message : String(err));
    } finally {
      this.aggregator.finish();
      this.cleanup();
    }

    return this.aggregator.computeResult();
  }

  /**
   * Basic ramp and connectivity workload (expanded in subsequent checkpoints).
   */
  private async runBasicWorkload(): Promise<void> {
    const { connections, rampRate, durationSec } = this.config;
    const batchSize = Math.max(1, Math.min(rampRate, connections));
    let connected = 0;

    while (connected < connections && !this.isAborted) {
      const batchCount = Math.min(batchSize, connections - connected);
      const promises: Promise<WebSocket>[] = [];

      for (let i = 0; i < batchCount; i++) {
        const clientId = `bench-client-${connected + i + 1}`;
        promises.push(this.connectClient(clientId).catch((err) => {
          this.aggregator.recordError(`Connection ${clientId} failed: ${err.message}`);
          return null as any;
        }));
      }

      await Promise.all(promises);
      connected += batchCount;

      if (connected < connections) {
        await new Promise((r) => setTimeout(r, 1000 / (rampRate / batchSize)));
      }
    }

    // Keep connections open for test duration
    const holdMs = Math.min(durationSec * 1000, 2000);
    await new Promise((r) => setTimeout(r, holdMs));
  }

  private async runRampWorkload(): Promise<void> {
    const profile = new RampProfile(this.config, this.aggregator);
    await profile.execute();
  }

  public static formatReport(result: BenchmarkResult): string {
    const lines: string[] = [];
    lines.push('='.repeat(80));
    lines.push(` PULSE BENCHMARK REPORT`);
    lines.push(` Profile: ${result.profile} | Target: ${result.target} | Duration: ${result.durationSec.toFixed(1)}s`);
    lines.push('='.repeat(80));
    lines.push(` Connections Attempted:     ${result.connectionsAttempted}`);
    const estPct =
      result.connectionsAttempted > 0
        ? ((result.connectionsEstablished / result.connectionsAttempted) * 100).toFixed(1)
        : '0.0';
    lines.push(` Connections Established:   ${result.connectionsEstablished} (${estPct}%)`);
    lines.push(` Connections Failed:        ${result.connectionsFailed}`);
    lines.push(` Messages Sent:             ${result.messagesSent}`);
    lines.push(` Messages Received:         ${result.messagesReceived} (${result.deliveryRatePercent.toFixed(1)}%)`);
    lines.push(` Messages Dropped:          ${result.messagesDropped}`);
    lines.push(` Aggregate Throughput:      ${result.throughputMsgPerSec} msg/sec`);
    lines.push('');
    lines.push(' Latency Distribution:');
    lines.push(`   Min:                     ${result.latency.minMs.toFixed(2)} ms`);
    lines.push(`   Mean:                    ${result.latency.meanMs.toFixed(2)} ms`);
    lines.push(`   p50 (Median):            ${result.latency.p50Ms.toFixed(2)} ms`);
    lines.push(`   p90:                     ${result.latency.p90Ms.toFixed(2)} ms`);
    lines.push(`   p95:                     ${result.latency.p95Ms.toFixed(2)} ms`);
    lines.push(`   p99:                     ${result.latency.p99Ms.toFixed(2)} ms`);
    lines.push(`   Max:                     ${result.latency.maxMs.toFixed(2)} ms`);
    lines.push('');
    lines.push(' Connection Establishment Latency:');
    lines.push(`   p50:                     ${result.connectLatency.p50Ms.toFixed(2)} ms`);
    lines.push(`   p95:                     ${result.connectLatency.p95Ms.toFixed(2)} ms`);
    lines.push(`   Max:                     ${result.connectLatency.maxMs.toFixed(2)} ms`);
    lines.push('');

    if (result.slaViolations.length > 0) {
      lines.push(' SLA Violations:');
      for (const v of result.slaViolations) {
        lines.push(`   - ${v}`);
      }
      lines.push('');
    }

    if (result.errors.length > 0) {
      lines.push(' Errors Encountered:');
      for (const err of result.errors.slice(0, 5)) {
        lines.push(`   - ${err}`);
      }
      lines.push('');
    }

    const verdict = result.passed ? 'PASS — ALL SLA TARGETS MET' : 'FAIL — SLA VIOLATION OR ERRORS DETECTED';
    lines.push(` Final Verdict:             ${verdict}`);
    lines.push('='.repeat(80));

    return lines.join('\n');
  }
}
