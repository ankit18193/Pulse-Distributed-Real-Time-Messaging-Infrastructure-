import { parseArgs, formatTerminalTable, main } from '../../bin/pulse-chaos.js';
import { ChaosScenarioResult } from '../../src/chaos/types.js';

describe('Chaos Testing CLI (pulse-chaos)', () => {
  describe('Argument Parsing', () => {
    it('parses --help and -h flags', () => {
      expect(parseArgs(['--help']).help).toBe(true);
      expect(parseArgs(['-h']).help).toBe(true);
    });

    it('parses --version and -v flags', () => {
      expect(parseArgs(['--version']).version).toBe(true);
      expect(parseArgs(['-v']).version).toBe(true);
    });

    it('parses --scenario and -s flag with custom scenario name', () => {
      const res1 = parseArgs(['--scenario', 'redis-outage']);
      expect(res1.options.scenario).toBe('redis-outage');

      const res2 = parseArgs(['-s', 'backpressure']);
      expect(res2.options.scenario).toBe('backpressure');
    });

    it('parses --json and --verbose flags', () => {
      const res = parseArgs(['--json', '--verbose']);
      expect(res.options.json).toBe(true);
      expect(res.options.verbose).toBe(true);
    });

    it('parses custom redis host and port', () => {
      const res = parseArgs(['--redis-host', '10.0.0.5', '--redis-port', '6381']);
      expect(res.options.redisHost).toBe('10.0.0.5');
      expect(res.options.redisPort).toBe(6381);
    });
  });

  describe('Terminal Table Formatting', () => {
    it('formats mixed scenario results into ANSI table with summary footer', () => {
      const sampleResults: ChaosScenarioResult[] = [
        {
          scenarioId: 'drill-1',
          name: 'Passed Scenario',
          status: 'PASSED',
          timing: { faultInjectedAt: 1000, mttdMs: 12, mttrMs: 150 },
          metricsAsserted: { mttdMs: 12 }
        },
        {
          scenarioId: 'drill-2',
          name: 'Failed Scenario',
          status: 'FAILED',
          timing: { faultInjectedAt: 1000 },
          metricsAsserted: {},
          error: 'Simulated assertion failure'
        },
        {
          scenarioId: 'drill-3',
          name: 'Unavailable Scenario',
          status: 'UNAVAILABLE',
          timing: { faultInjectedAt: 1000 },
          metricsAsserted: {},
          error: 'PREREQUISITE_FAILED: Redis down'
        }
      ];

      const table = formatTerminalTable(sampleResults, 1.25);
      expect(table).toContain('Passed Scenario');
      expect(table).toContain('PASSED');
      expect(table).toContain('Failed Scenario');
      expect(table).toContain('FAILED');
      expect(table).toContain('Unavailable Scenario');
      expect(table).toContain('UNAVAILABLE');
      expect(table).toContain('Summary: Total: 3 | Passed: 1 | Failed: 1 | Unavailable: 1 | Duration: 1.25s');
    });
  });

  describe('Main CLI Invocations', () => {
    it('exits with code 0 on --help', async () => {
      const code = await main(['--help']);
      expect(code).toBe(0);
    });

    it('exits with code 0 on --version', async () => {
      const code = await main(['--version']);
      expect(code).toBe(0);
    });

    it('exits with code 1 on unknown scenario', async () => {
      const code = await main(['--scenario', 'non-existent-scenario']);
      expect(code).toBe(1);
    });

    it('runs graceful-draining drill via main() and exits with 0', async () => {
      const code = await main(['--scenario', 'graceful-draining']);
      expect(code).toBe(0);
    });
  });
});
