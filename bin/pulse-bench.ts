#!/usr/bin/env node
/**
 * Pulse — Distributed Real-Time Messaging Infrastructure
 * Empirical Benchmark CLI Entrypoint
 *
 * Standalone, dependency-free load testing harness.
 * Requires NO external Python, k6, or Grafana runtime.
 */

import { BenchmarkRunner } from '../src/bench/BenchmarkRunner.js';
import { BenchmarkConfig } from '../src/bench/types.js';

export function parseArgs(argv: string[]): {
  help: boolean;
  version: boolean;
  config: Partial<BenchmarkConfig>;
} {
  const partial: Partial<BenchmarkConfig> = {};
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--version' || arg === '-v') {
      version = true;
    } else if (arg === '--json') {
      partial.json = true;
    } else if (arg === '--force-high-concurrency') {
      partial.forceHighConcurrency = true;
    } else if ((arg === '--target' || arg === '-t') && i + 1 < argv.length) {
      partial.target = argv[++i];
    } else if ((arg === '--profile' || arg === '-p') && i + 1 < argv.length) {
      partial.profile = argv[++i] as any;
    } else if ((arg === '--connections' || arg === '-c') && i + 1 < argv.length) {
      partial.connections = parseInt(argv[++i], 10);
    } else if ((arg === '--duration' || arg === '-d') && i + 1 < argv.length) {
      partial.durationSec = parseFloat(argv[++i]);
    } else if ((arg === '--ramp-rate' || arg === '-r') && i + 1 < argv.length) {
      partial.rampRate = parseInt(argv[++i], 10);
    } else if ((arg === '--message-rate' || arg === '-m') && i + 1 < argv.length) {
      partial.messageRate = parseInt(argv[++i], 10);
    } else if (arg === '--rooms' && i + 1 < argv.length) {
      partial.rooms = parseInt(argv[++i], 10);
    } else if (arg === '--auth-secret' && i + 1 < argv.length) {
      partial.authSecret = argv[++i];
    }
  }

  return { help, version, config: partial };
}

export function printHelp(): void {
  console.log(`
Pulse Empirical Benchmark CLI (pulse-bench)

USAGE:
  pulse-bench [OPTIONS]

OPTIONS:
  -t, --target <url>             Target WebSocket server URL (default: ws://localhost:8080)
  -p, --profile <profile>        Benchmark profile (default: broadcast)
                                 Supported: broadcast, direct, presence, ramp, backpressure
  -c, --connections <number>     Target concurrent connections (default: 50, safe cap: 5000)
  -d, --duration <seconds>       Benchmark duration in seconds (default: 5)
  -r, --ramp-rate <number>       Connection establishment rate conns/sec (default: 25)
  -m, --message-rate <number>    Messages per second per sending client (default: 10)
      --rooms <number>           Room count for broadcast profile (default: 5)
      --auth-secret <string>     Shared HMAC secret for JWT authentication
      --force-high-concurrency   Override the 5,000 connection laptop safety cap
      --json                     Output report strictly as JSON
  -v, --version                  Display version information
  -h, --help                     Display this help text

EXAMPLES:
  # Conservative baseline broadcast benchmark
  npx tsx bin/pulse-bench.ts --profile broadcast --connections 50 --duration 10

  # Connection saturation ramp
  npx tsx bin/pulse-bench.ts --profile ramp --connections 200 --ramp-rate 50

  # Machine-readable JSON output for CI/CD
  npx tsx bin/pulse-bench.ts --json --profile broadcast --duration 5
`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { help, version, config } = parseArgs(argv);

  if (help) {
    printHelp();
    return 0;
  }

  if (version) {
    console.log('pulse-bench v0.1.0');
    return 0;
  }

  let runner: BenchmarkRunner;
  try {
    runner = new BenchmarkRunner(config);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // Handle clean shutdown on interrupt signals
  const onSignal = () => {
    console.warn('\nBenchmark interrupted. Cleaning up active sockets...');
    runner.abort();
  };

  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    const result = await runner.run();

    if (config.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(BenchmarkRunner.formatReport(result));
    }

    return result.passed ? 0 : 1;
  } catch (err) {
    console.error(`Benchmark execution failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

// Direct CLI execution check compatible with tsx, node, and jest
const isDirectExecution =
  typeof process !== 'undefined' &&
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('pulse-bench.ts') || process.argv[1].endsWith('pulse-bench.js')) &&
  typeof (globalThis as any).describe === 'undefined';

if (isDirectExecution) {
  main().then((code) => {
    process.exit(code);
  });
}
