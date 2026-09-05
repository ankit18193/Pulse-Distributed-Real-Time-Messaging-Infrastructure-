import net from 'net';
import http from 'http';
import {
  ChaosScenario,
  ChaosScenarioContext,
  ChaosScenarioResult,
  ChaosTimingMetrics
} from './types.js';
import { logger } from '../utils/logger.js';

export class ChaosScenarioRunner {
  private scenarios: Map<string, ChaosScenario> = new Map();

  public register(scenario: ChaosScenario): void {
    this.scenarios.set(scenario.id, scenario);
  }

  public getScenario(id: string): ChaosScenario | undefined {
    return this.scenarios.get(id);
  }

  public getAllScenarios(): ChaosScenario[] {
    return Array.from(this.scenarios.values());
  }

  /**
   * Helper to verify real Redis connectivity before running distributed scenarios.
   * Throws an error or returns false if unreachable.
   */
  public static async probeRedis(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let resolved = false;

      const finish = (result: boolean) => {
        if (!resolved) {
          resolved = true;
          socket.destroy();
          resolve(result);
        }
      };

      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));

      try {
        socket.connect(port, host);
      } catch {
        finish(false);
      }
    });
  }

  /**
   * Scrapes Prometheus metrics from a live Pulse HTTP server.
   * Parses metric values for assertions.
   */
  public static async scrapeMetrics(
    port: number,
    host = '127.0.0.1'
  ): Promise<Map<string, number>> {
    return new Promise((resolve, reject) => {
      const req = http.get(`http://${host}:${port}/metrics`, (res) => {
        let rawData = '';
        res.on('data', (chunk) => {
          rawData += chunk;
        });
        res.on('end', () => {
          const metricsMap = new Map<string, number>();
          const lines = rawData.split('\n');

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) {
              continue;
            }

            // e.g. pulse_redis_connection_state 1
            // or pulse_connections_closed_total{reason="heartbeat_timeout"} 2
            const spaceIdx = trimmed.lastIndexOf(' ');
            if (spaceIdx !== -1) {
              const name = trimmed.substring(0, spaceIdx).trim();
              const valStr = trimmed.substring(spaceIdx + 1).trim();
              const val = parseFloat(valStr);
              if (!isNaN(val)) {
                metricsMap.set(name, val);
              }
            }
          }
          resolve(metricsMap);
        });
      });

      req.on('error', (err) => {
        reject(err);
      });
      req.setTimeout(3000, () => {
        req.destroy(new Error('Scrape metrics timeout'));
      });
    });
  }

  /**
   * Starts a monotonic high-resolution timer.
   * Returns a function that returns elapsed milliseconds.
   */
  public static startMonotonicTimer(): () => number {
    const startHr = process.hrtime.bigint();
    return () => {
      const diffNs = process.hrtime.bigint() - startHr;
      return Number(diffNs) / 1e6;
    };
  }

  /**
   * Runs a single registered scenario.
   */
  public async runScenario(
    id: string,
    contextOverrides: Partial<ChaosScenarioContext> = {}
  ): Promise<ChaosScenarioResult> {
    const scenario = this.scenarios.get(id);
    if (!scenario) {
      throw new Error(`Chaos scenario '${id}' is not registered`);
    }

    const defaultContext: ChaosScenarioContext = {
      pulsePortA: 9201,
      pulsePortB: 9202,
      redisHost: process.env.REDIS_HOST || '127.0.0.1',
      redisPort: Number(process.env.REDIS_PORT) || 6379,
      redisProxyPort: 6389,
      authSecret: 'pulse-chaos-secret-key-min-32-chars-long!'
    };

    const ctx: ChaosScenarioContext = {
      ...defaultContext,
      ...contextOverrides
    };

    logger.info(`Starting chaos scenario execution: ${scenario.name} [${scenario.id}]`);
    try {
      const result = await scenario.execute(ctx);
      logger.info(`Completed chaos scenario: ${scenario.name} -> ${result.status}`, {
        scenarioId: result.scenarioId,
        status: result.status,
        mttdMs: result.timing.mttdMs,
        mttrMs: result.timing.mttrMs
      });
      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Chaos scenario execution failed: ${scenario.name}`, {
        scenarioId: scenario.id,
        error: errorMsg
      });

      const failureMetrics: ChaosTimingMetrics = {
        faultInjectedAt: Date.now()
      };

      return {
        scenarioId: scenario.id,
        name: scenario.name,
        status: errorMsg.includes('PREREQUISITE_FAILED') ? 'UNAVAILABLE' : 'FAILED',
        timing: failureMetrics,
        metricsAsserted: {},
        error: errorMsg
      };
    }
  }

  /**
   * Runs all registered scenarios sequentially.
   */
  public async runAll(
    contextOverrides: Partial<ChaosScenarioContext> = {}
  ): Promise<ChaosScenarioResult[]> {
    const results: ChaosScenarioResult[] = [];
    for (const scenario of this.scenarios.values()) {
      const result = await this.runScenario(scenario.id, contextOverrides);
      results.push(result);
    }
    return results;
  }
}
