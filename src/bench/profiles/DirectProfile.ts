/**
 * Pulse — Distributed Real-Time Messaging Infrastructure
 * Direct Peer-to-Peer Messaging Benchmark Profile
 */

import { WebSocket } from 'ws';
import { Authenticator } from '../../auth/Authenticator.js';
import { generateUUIDv7 } from '../../utils/uuidv7.js';
import { StatsAggregator } from '../StatsAggregator.js';
import { BenchmarkConfig } from '../types.js';
import { PulseEventEnvelope } from '../../types/index.js';

export interface DirectClient {
  userId: string;
  ws: WebSocket;
  targetUserId: string;
}

export class DirectProfile {
  private readonly config: BenchmarkConfig;
  private readonly aggregator: StatsAggregator;
  private readonly clients: DirectClient[] = [];
  private isAborted: boolean = false;
  private ackCount: number = 0;

  constructor(config: BenchmarkConfig, aggregator: StatsAggregator) {
    this.config = config;
    this.aggregator = aggregator;
  }

  public getClientCount(): number {
    return this.clients.length;
  }

  public getAckCount(): number {
    return this.ackCount;
  }

  public async execute(): Promise<void> {
    const { connections, target, authSecret, durationSec, messageRate } = this.config;
    const auth = new Authenticator(authSecret);

    // Need at least 2 clients for peer-to-peer messaging
    const totalClients = Math.max(2, connections);

    // 1. Establish connections
    for (let i = 0; i < totalClients && !this.isAborted; i++) {
      const userId = `direct-client-${i + 1}`;
      // Pair client i with (i + 1) mod totalClients
      const targetUserId = `direct-client-${((i + 1) % totalClients) + 1}`;

      const token = auth.generateToken({
        userId,
        roles: ['user'],
        expiresInMs: (durationSec + 60) * 1000
      });

      const separator = target.includes('?') ? '&' : '?';
      const url = `${target}${separator}token=${encodeURIComponent(token)}`;

      this.aggregator.recordConnectionAttempt();
      const startConnect = process.hrtime.bigint();

      try {
        const ws = await new Promise<WebSocket>((resolve, reject) => {
          const socket = new WebSocket(url);
          socket.once('open', () => {
            const elapsed = Number(process.hrtime.bigint() - startConnect) / 1e6;
            this.aggregator.recordConnectionSuccess(elapsed);
            resolve(socket);
          });
          socket.once('error', (err) => {
            this.aggregator.recordConnectionFailure(err.message);
            reject(err);
          });
        });

        // Set up message listener for incoming direct messages and ACKs
        ws.on('message', (data: Buffer | string) => {
          try {
            const parsed: PulseEventEnvelope = JSON.parse(data.toString());
            if (parsed.type === 'DIRECT_MESSAGE') {
              const payload = parsed.payload as any;
              if (payload && payload.sentAtHr) {
                const latencyMs = Number(process.hrtime.bigint() - BigInt(payload.sentAtHr)) / 1e6;
                this.aggregator.recordReceived(1, latencyMs);
              } else {
                this.aggregator.recordReceived(1);
              }
            } else if (parsed.type === 'DELIVERY_ACK') {
              this.ackCount++;
            }
          } catch {
            // Ignore parse errors on telemetry listener
          }
        });

        this.clients.push({ userId, ws, targetUserId });
      } catch (err) {
        this.aggregator.recordError(`Connection ${userId} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (this.clients.length < 2 || this.isAborted) {
      return;
    }

    // Brief stabilization window
    await new Promise((r) => setTimeout(r, 50));

    // 2. Generate direct unicast traffic
    const intervalMs = Math.max(10, Math.floor(1000 / messageRate));
    const startTime = Date.now();
    const endTime = startTime + durationSec * 1000;

    while (Date.now() < endTime && !this.isAborted) {
      for (const client of this.clients) {
        if (client.ws.readyState === WebSocket.OPEN) {
          const directMessage: PulseEventEnvelope = {
            eventId: generateUUIDv7(),
            type: 'DIRECT_MESSAGE',
            timestamp: Date.now(),
            senderId: client.userId,
            target: { recipientId: client.targetUserId },
            ackRequired: true,
            payload: {
              text: 'Pulse empirical benchmark unicast payload',
              sentAtHr: process.hrtime.bigint().toString()
            }
          };

          client.ws.send(JSON.stringify(directMessage));
          this.aggregator.recordSent(1);
        }
      }

      await new Promise((r) => setTimeout(r, intervalMs));
    }

    // Drain remaining in-flight deliveries and ACKs
    await new Promise((r) => setTimeout(r, 200));
  }

  public abort(): void {
    this.isAborted = true;
    this.cleanup();
  }

  public cleanup(): void {
    for (const client of this.clients) {
      try {
        if (client.ws.readyState === WebSocket.OPEN || client.ws.readyState === WebSocket.CONNECTING) {
          client.ws.close(1000, 'Benchmark completed');
        }
      } catch {
        // Ignore teardown errors
      }
    }
    this.clients.length = 0;
  }
}
