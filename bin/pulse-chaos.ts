#!/usr/bin/env node
/**
 * Pulse — Distributed Real-Time Messaging Infrastructure
 * Standalone Chaos Testing CLI Entrypoint (pulse-chaos)
 *
 * Automated drill runner for failure injection and resilience validation.
 */

import { ChaosScenarioRunner } from '../src/chaos/ChaosScenarioRunner.js';
import { registerAllScenarios } from '../src/chaos/scenarios.js';
import { ChaosScenarioContext, ChaosScenarioResult } from '../src/chaos/types.js';

export interface ChaosCliOptions {
  scenario: string;
  verbose: boolean;
  json: boolean;
  redisHost: string;
  redisPort: number;
}

export function parseArgs(argv: string[]): {
  help: boolean;
  version: boolean;
  options: ChaosCliOptions;
} {
  let help = false;
  let version = false;
  const options: ChaosCliOptions = {
    scenario: 'all',
    verbose: false,
    json: false,
    redisHost: process.env.REDIS_HOST || '127.0.0.1',
    redisPort: parseInt(process.env.REDIS_PORT || '6379', 10)
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--version' || arg === '-v') {
      version = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--verbose') {
      options.verbose = true;
    } else if ((arg === '--scenario' || arg === '-s') && i + 1 < argv.length) {
      options.scenario = argv[++i];
    } else if (arg === '--redis-host' && i + 1 < argv.length) {
      options.redisHost = argv[++i];
    } else if (arg === '--redis-port' && i + 1 < argv.length) {
      options.redisPort = parseInt(argv[++i], 10);
    }
  }

  return { help, version, options };
}

export function printHelp(): void {
  console.log(`
Pulse Chaos Testing CLI (pulse-chaos)

Automated failure injection and resilience testing harness for Pulse clusters.

USAGE:
  pulse-chaos [OPTIONS]

OPTIONS:
  -s, --scenario <name>     Scenario to run (default: all)
                            Available:
                              - all
                              - redis-outage
                              - node-crash
                              - reconnect-storm
                              - half-open
                              - ack-loss
                              - backpressure
                              - graceful-draining
      --redis-host <host>   Redis host endpoint (default: 127.0.0.1 or REDIS_HOST env)
      --redis-port <port>   Redis port endpoint (default: 6379 or REDIS_PORT env)
      --verbose             Enable detailed logs during test execution
      --json                Output results strictly as machine-readable JSON
  -v, --version             Display version information
  -h, --help                Display this help text

EXAMPLES:
  # Execute all failure scenarios sequentially
  npx tsx bin/pulse-chaos.ts --scenario all

  # Run a specific failure scenario
  npx tsx bin/pulse-chaos.ts --scenario redis-outage

  # Machine-readable output for CI pipelines
  npx tsx bin/pulse-chaos.ts --scenario all --json
`);
}

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

export function formatTerminalTable(results: ChaosScenarioResult[], durationSec: number): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(`${ANSI.bold}${ANSI.cyan}========================================================================================${ANSI.reset}`);
  lines.push(`${ANSI.bold}${ANSI.cyan}                      PULSE CHAOS & RESILIENCE TEST RESULTS                             ${ANSI.reset}`);
  lines.push(`${ANSI.bold}${ANSI.cyan}========================================================================================${ANSI.reset}`);
  lines.push('');

  const colScenario = 34;
  const colStatus = 14;
  const colMttd = 12;
  const colMttr = 12;

  const header =
    'SCENARIO'.padEnd(colScenario) +
    'STATUS'.padEnd(colStatus) +
    'MTTD (ms)'.padEnd(colMttd) +
    'MTTR (ms)'.padEnd(colMttr) +
    'DETAILS';
  lines.push(`${ANSI.bold}${header}${ANSI.reset}`);
  lines.push(`${ANSI.gray}${'-'.repeat(88)}${ANSI.reset}`);

  let passedCount = 0;
  let failedCount = 0;
  let unavailableCount = 0;

  for (const r of results) {
    let statusColored: string;
    if (r.status === 'PASSED') {
      passedCount++;
      statusColored = `${ANSI.green}PASSED${ANSI.reset}`.padEnd(colStatus + 9);
    } else if (r.status === 'UNAVAILABLE') {
      unavailableCount++;
      statusColored = `${ANSI.yellow}UNAVAILABLE${ANSI.reset}`.padEnd(colStatus + 9);
    } else {
      failedCount++;
      statusColored = `${ANSI.red}FAILED${ANSI.reset}`.padEnd(colStatus + 9);
    }

    const mttd = r.timing.mttdMs !== undefined ? `${Math.round(r.timing.mttdMs)}ms` : '-';
    const mttr = r.timing.mttrMs !== undefined ? `${Math.round(r.timing.mttrMs)}ms` : '-';

    let details = '';
    if (r.error) {
      details = r.error.length > 35 ? r.error.substring(0, 32) + '...' : r.error;
    } else {
      details = Object.entries(r.metricsAsserted)
        .map(([k, v]) => `${k}=${v}`)
        .slice(0, 2)
        .join(', ');
    }

    const row =
      r.name.padEnd(colScenario) +
      statusColored +
      mttd.padEnd(colMttd) +
      mttr.padEnd(colMttr) +
      details;
    lines.push(row);
  }

  lines.push(`${ANSI.gray}${'-'.repeat(88)}${ANSI.reset}`);
  const summaryColor = failedCount > 0 || unavailableCount > 0 ? ANSI.red : ANSI.green;
  lines.push(
    `${summaryColor}${ANSI.bold}Summary: Total: ${results.length} | Passed: ${passedCount} | Failed: ${failedCount} | Unavailable: ${unavailableCount} | Duration: ${durationSec.toFixed(2)}s${ANSI.reset}`
  );
  lines.push('');

  return lines.join('\n');
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { help, version, options } = parseArgs(argv);

  if (help) {
    printHelp();
    return 0;
  }

  if (version) {
    console.log('pulse-chaos v0.1.0');
    return 0;
  }

  const runner = new ChaosScenarioRunner();
  registerAllScenarios(runner);

  const contextOverrides: Partial<ChaosScenarioContext> = {
    redisHost: options.redisHost,
    redisPort: options.redisPort,
    pulsePortA: 9301,
    pulsePortB: 9302,
    redisProxyPort: 6389
  };

  const startTime = Date.now();
  const results: ChaosScenarioResult[] = [];

  const targetScenario = options.scenario.toLowerCase().trim();

  if (targetScenario === 'all') {
    if (!options.json) {
      console.log(`\nExecuting all chaos drills against Pulse cluster...\n`);
    }
    const allScenarios = runner.getAllScenarios();
    for (const sc of allScenarios) {
      if (!options.json && options.verbose) {
        console.log(`-> Running drill: ${sc.name} (${sc.id})...`);
      }
      const res = await runner.runScenario(sc.id, contextOverrides);
      results.push(res);
    }
  } else {
    const scenario = runner.getScenario(targetScenario);
    if (!scenario) {
      console.error(
        `Error: Unknown scenario '${targetScenario}'. Run 'pulse-chaos --help' to view available scenarios.`
      );
      return 1;
    }
    if (!options.json && options.verbose) {
      console.log(`-> Running drill: ${scenario.name} (${scenario.id})...`);
    }
    const res = await runner.runScenario(scenario.id, contextOverrides);
    results.push(res);
  }

  const durationSec = (Date.now() - startTime) / 1000;

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(formatTerminalTable(results, durationSec));
  }

  const allPassed = results.every((r) => r.status === 'PASSED');
  return allPassed ? 0 : 1;
}

const isDirectExecution =
  typeof process !== 'undefined' &&
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('pulse-chaos.ts') || process.argv[1].endsWith('pulse-chaos.js')) &&
  typeof (globalThis as any).describe === 'undefined';

if (isDirectExecution) {
  main().then((code) => {
    process.exit(code);
  });
}
