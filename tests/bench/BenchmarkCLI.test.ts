/**
 * Pulse — Distributed Real-Time Messaging Infrastructure
 * Checkpoint 13: Standalone Benchmark CLI & Runner Tests
 */

import { parseArgs, main } from '../../bin/pulse-bench.js';
import { BenchmarkRunner, SAFE_MAX_CONNECTIONS } from '../../src/bench/BenchmarkRunner.js';
import { StatsAggregator } from '../../src/bench/StatsAggregator.js';
import { Authenticator } from '../../src/auth/Authenticator.js';

describe('Checkpoint 13: Standalone Benchmark CLI & Runner', () => {
  describe('CLI Argument Parsing & Validation', () => {
    it('parses safe default configurations when no flags are supplied', () => {
      const { help, version, config } = parseArgs([]);

      expect(help).toBe(false);
      expect(version).toBe(false);
      expect(config.target).toBeUndefined(); // default will be applied by runner
      expect(config.connections).toBeUndefined();

      const runner = new BenchmarkRunner(config);
      const validated = runner.getConfig();

      expect(validated.target).toBe('ws://localhost:8080');
      expect(validated.profile).toBe('broadcast');
      expect(validated.connections).toBe(50);
      expect(validated.durationSec).toBe(5);
      expect(validated.rampRate).toBe(25);
      expect(validated.json).toBe(false);
      expect(validated.forceHighConcurrency).toBe(false);
    });

    it('parses custom flags and overrides', () => {
      const argv = [
        '--target', 'ws://127.0.0.1:9000',
        '--profile', 'direct',
        '--connections', '120',
        '--duration', '15',
        '--ramp-rate', '40',
        '--message-rate', '20',
        '--rooms', '8',
        '--json'
      ];

      const { config } = parseArgs(argv);
      const runner = new BenchmarkRunner(config);
      const validated = runner.getConfig();

      expect(validated.target).toBe('ws://127.0.0.1:9000');
      expect(validated.profile).toBe('direct');
      expect(validated.connections).toBe(120);
      expect(validated.durationSec).toBe(15);
      expect(validated.rampRate).toBe(40);
      expect(validated.messageRate).toBe(20);
      expect(validated.rooms).toBe(8);
      expect(validated.json).toBe(true);
    });

    it('rejects invalid target URLs (not starting with ws:// or wss://)', () => {
      expect(() => {
        BenchmarkRunner.validateConfig({ target: 'http://localhost:8080' });
      }).toThrow(/Invalid benchmark target URL/);
    });

    it('rejects invalid benchmark profile names', () => {
      expect(() => {
        BenchmarkRunner.validateConfig({ profile: 'unknown-profile' as any });
      }).toThrow(/Unknown benchmark profile/);
    });

    it('enforces safe maximum connection cap (>5000) by default', () => {
      expect(() => {
        BenchmarkRunner.validateConfig({ connections: 5001 });
      }).toThrow(new RegExp(`exceeds safe limit of ${SAFE_MAX_CONNECTIONS}`));
    });

    it('allows high connection counts when --force-high-concurrency is set', () => {
      const config = BenchmarkRunner.validateConfig({
        connections: 10000,
        forceHighConcurrency: true
      });
      expect(config.connections).toBe(10000);
      expect(config.forceHighConcurrency).toBe(true);
    });

    it('creates authenticated WebSocket URLs with HMAC tokens', () => {
      const runner = new BenchmarkRunner({ authSecret: 'test-secret' });
      const url = runner.createAuthenticatedUrl('user-bench-1');

      expect(url).toContain('ws://localhost:8080?token=');
      const token = new URL(url).searchParams.get('token');
      const auth = new Authenticator('test-secret');
      const verified = auth.verifyToken(token);
      expect(verified.authenticated).toBe(true);
      expect(verified.userId).toBe('user-bench-1');
    });
  });

  describe('StatsAggregator & Percentile Calculations', () => {
    it('handles empty sample arrays gracefully without NaN or crash', () => {
      const stats = StatsAggregator.calculatePercentiles([]);
      expect(stats.count).toBe(0);
      expect(stats.minMs).toBe(0);
      expect(stats.maxMs).toBe(0);
      expect(stats.meanMs).toBe(0);
      expect(stats.p50Ms).toBe(0);
      expect(stats.p95Ms).toBe(0);
      expect(stats.p99Ms).toBe(0);
    });

    it('accurately calculates percentiles on known sample distributions', () => {
      // 100 samples from 1ms to 100ms
      const samples: number[] = [];
      for (let i = 1; i <= 100; i++) {
        samples.push(i);
      }

      const stats = StatsAggregator.calculatePercentiles(samples);
      expect(stats.count).toBe(100);
      expect(stats.minMs).toBe(1);
      expect(stats.maxMs).toBe(100);
      expect(stats.meanMs).toBe(50.5);
      expect(stats.p50Ms).toBe(50.5);
      expect(stats.p90Ms).toBeCloseTo(90.1, 1);
      expect(stats.p95Ms).toBeCloseTo(95.05, 1);
      expect(stats.p99Ms).toBeCloseTo(99.01, 1);
    });

    it('aggregates connection, throughput, and error metrics', () => {
      const config = BenchmarkRunner.validateConfig({ durationSec: 10 });
      const agg = new StatsAggregator(config);

      agg.recordConnectionAttempt();
      agg.recordConnectionSuccess(5.2);
      agg.recordConnectionAttempt();
      agg.recordConnectionFailure('Socket hang up');

      agg.recordSent(100);
      agg.recordReceived(98, 2.1);
      agg.recordDropped(2);
      agg.finish();

      const result = agg.computeResult();
      expect(result.connectionsAttempted).toBe(2);
      expect(result.connectionsEstablished).toBe(1);
      expect(result.connectionsFailed).toBe(1);
      expect(result.messagesSent).toBe(100);
      expect(result.messagesReceived).toBe(98);
      expect(result.messagesDropped).toBe(2);
      expect(result.deliveryRatePercent).toBe(98);
      expect(result.throughputMsgPerSec).toBeGreaterThan(0);
      expect(result.errors).toContain('Socket hang up');
      expect(result.passed).toBe(false); // Connection failed
    });
  });

  describe('Report Formatting & CLI Help', () => {
    it('formats human-readable summary table with all critical metrics', () => {
      const config = BenchmarkRunner.validateConfig({});
      const agg = new StatsAggregator(config);
      agg.recordConnectionAttempt();
      agg.recordConnectionSuccess(2.0);
      agg.recordSent(50);
      agg.recordReceived(50, 1.5);
      agg.finish();

      const result = agg.computeResult();
      const text = BenchmarkRunner.formatReport(result);

      expect(text).toContain('PULSE BENCHMARK REPORT');
      expect(text).toContain('Connections Established:   1');
      expect(text).toContain('Messages Sent:             50');
      expect(text).toContain('Messages Received:         50 (100.0%)');
      expect(text).toContain('Final Verdict:             PASS — ALL SLA TARGETS MET');
    });

    it('handles CLI --help flag and returns 0 exit code', async () => {
      const code = await main(['--help']);
      expect(code).toBe(0);
    });

    it('handles CLI --version flag and returns 0 exit code', async () => {
      const code = await main(['--version']);
      expect(code).toBe(0);
    });

    it('returns 1 exit code on validation failure', async () => {
      const code = await main(['--target', 'invalid-protocol://foo']);
      expect(code).toBe(1);
    });
  });
});
