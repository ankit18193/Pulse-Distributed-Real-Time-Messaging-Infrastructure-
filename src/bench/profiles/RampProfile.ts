/**
 * Pulse — Distributed Real-Time Messaging Infrastructure
 * Connection Ramp & Saturation Benchmark Profile
 */

import { WebSocket } from 'ws';
import { BenchmarkConfig } from '../types.js';
import { StatsAggregator } from '../StatsAggregator.js';
import { Authenticator } from '../../auth/Authenticator.js';

export class RampProfile {
  private readonly config: BenchmarkConfig;
  private readonly aggregator: StatsAggregator;
  private readonly activeSockets: Set<WebSocket> = new Set();
  private isAborted: boolean = false;

  constructor(config: BenchmarkConfig, aggregator: StatsAggregator) {
    this.config = config;
    this.aggregator = aggregator;
  }

  public getActiveSocketCount(): number {
    return this.activeSockets.size;
  }

  public async execute(): Promise<void> {
    const { connections, rampRate, durationSec, target, authSecret } = this.config;
    const auth = new Authenticator(authSecret);

    // Calculate pacing interval between connection establishments
    const intervalMs = Math.max(0, Math.floor(1000 / rampRate));
    const connectPromises: Promise<WebSocket | null>[] = [];

    for (let i = 0; i < connections && !this.isAborted; i++) {
      const clientId = `ramp-client-${i + 1}`;
      const token = auth.generateToken({
        userId: clientId,
        roles: ['user'],
        expiresInMs: (durationSec + 60) * 1000
      });

      const separator = target.includes('?') ? '&' : '?';
      const url = `${target}${separator}token=${encodeURIComponent(token)}`;

      this.aggregator.recordConnectionAttempt();
      const startHr = process.hrtime.bigint();

      const p = new Promise<WebSocket | null>((resolve) => {
        let settled = false;
        const socket = new WebSocket(url);

        const onOpen = () => {
          if (settled) return;
          settled = true;
          const elapsedMs = Number(process.hrtime.bigint() - startHr) / 1e6;
          this.activeSockets.add(socket);
          this.aggregator.recordConnectionSuccess(elapsedMs);
          socket.removeListener('error', onError);
          resolve(socket);
        };

        const onError = (err: Error) => {
          if (settled) return;
          settled = true;
          this.aggregator.recordConnectionFailure(err.message);
          socket.removeListener('open', onOpen);
          resolve(null);
        };

        socket.once('open', onOpen);
        socket.once('error', onError);
      });

      connectPromises.push(p);

      if (i < connections - 1 && intervalMs > 0 && !this.isAborted) {
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }

    // Wait for all in-flight handshakes to complete
    await Promise.all(connectPromises);

    // Hold saturation state for duration
    if (!this.isAborted && durationSec > 0) {
      const holdTimeMs = Math.min(durationSec * 1000, 30000);
      await new Promise((r) => setTimeout(r, holdTimeMs));
    }
  }

  public abort(): void {
    this.isAborted = true;
    this.cleanup();
  }

  public cleanup(): void {
    for (const ws of this.activeSockets) {
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1000, 'Ramp benchmark completed');
        }
      } catch {
        // Ignore teardown errors
      }
    }
    this.activeSockets.clear();
  }
}
