/**
 * Pulse — Distributed Real-Time Messaging Infrastructure
 * Presence Churn Benchmark Profile
 *
 * Simulates rapid multi-device presence churn:
 * - Repeated connect/disconnect cycles
 * - Lease registration, multi-device overlap, and teardown
 * - Bounded memory and connection lifecycle stability
 */

import { WebSocket } from 'ws';
import { Authenticator } from '../../auth/Authenticator.js';
import { StatsAggregator } from '../StatsAggregator.js';
import { BenchmarkConfig } from '../types.js';

export interface ChurnCycleStats {
  round: number;
  connectedCount: number;
  disconnectedCount: number;
  durationMs: number;
}

export class PresenceChurnProfile {
  private readonly config: BenchmarkConfig;
  private readonly aggregator: StatsAggregator;
  private readonly cycleStats: ChurnCycleStats[] = [];
  private isAborted: boolean = false;
  private totalConnectedCycles: number = 0;
  private totalDisconnectedCycles: number = 0;

  constructor(config: BenchmarkConfig, aggregator: StatsAggregator) {
    this.config = config;
    this.aggregator = aggregator;
  }

  public getCycleStats(): ChurnCycleStats[] {
    return [...this.cycleStats];
  }

  public getTotalConnectedCycles(): number {
    return this.totalConnectedCycles;
  }

  public getTotalDisconnectedCycles(): number {
    return this.totalDisconnectedCycles;
  }

  public async execute(): Promise<void> {
    const { target, connections, durationSec, authSecret } = this.config;
    const auth = new Authenticator(authSecret);
    const batchSize = Math.max(2, Math.min(connections, 20));
    const startTime = Date.now();
    const endTime = startTime + durationSec * 1000;
    let round = 0;

    while (Date.now() < endTime && !this.isAborted) {
      round++;
      const roundStart = Date.now();
      const activeSockets: WebSocket[] = [];

      // Wave 1: Rapid connection burst (multi-device users)
      const connectPromises: Promise<WebSocket>[] = [];
      for (let i = 0; i < batchSize; i++) {
        const userId = `churn-user-${Math.floor(i / 2) + 1}`; // 2 devices per user
        const token = auth.generateToken({
          userId,
          roles: ['user'],
          expiresInMs: 30000
        });
        const separator = target.includes('?') ? '&' : '?';
        const url = `${target}${separator}token=${encodeURIComponent(token)}`;

        this.aggregator.recordConnectionAttempt();
        const startConnect = process.hrtime.bigint();

        const p = new Promise<WebSocket>((resolve, reject) => {
          const ws = new WebSocket(url);
          ws.once('open', () => {
            const elapsed = Number(process.hrtime.bigint() - startConnect) / 1e6;
            this.aggregator.recordConnectionSuccess(elapsed);
            resolve(ws);
          });
          ws.once('error', (err) => {
            this.aggregator.recordConnectionFailure(err.message);
            reject(err);
          });
        });

        connectPromises.push(p);
      }

      const results = await Promise.allSettled(connectPromises);
      for (const res of results) {
        if (res.status === 'fulfilled') {
          activeSockets.push(res.value);
          this.totalConnectedCycles++;
        }
      }

      // Brief dwell period to allow presence lease stabilization
      await new Promise((r) => setTimeout(r, 50));

      // Wave 2: Rapid teardown / disconnect with safety timer
      const closePromises: Promise<void>[] = [];
      for (const ws of activeSockets) {
        const p = new Promise<void>((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) {
            this.totalDisconnectedCycles++;
            return resolve();
          }

          let done = false;
          const finish = () => {
            if (!done) {
              done = true;
              this.totalDisconnectedCycles++;
              resolve();
            }
          };

          const timer = setTimeout(finish, 600);
          ws.once('close', () => {
            clearTimeout(timer);
            finish();
          });

          try {
            ws.close(1000, 'Churn cycle completion');
          } catch {
            clearTimeout(timer);
            finish();
          }
        });
        closePromises.push(p);
      }

      await Promise.allSettled(closePromises);

      this.cycleStats.push({
        round,
        connectedCount: activeSockets.length,
        disconnectedCount: activeSockets.length,
        durationMs: Date.now() - roundStart
      });

      // Brief pause between churn rounds
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  public abort(): void {
    this.isAborted = true;
  }

  public cleanup(): void {
    // Handled per cycle
  }
}
