/**
 * Pulse — Distributed Real-Time Messaging Infrastructure
 * Room Broadcast Storm Benchmark Profile
 */

import { WebSocket } from 'ws';
import { Authenticator } from '../../auth/Authenticator.js';
import { generateUUIDv7 } from '../../utils/uuidv7.js';
import { StatsAggregator } from '../StatsAggregator.js';
import { BenchmarkConfig } from '../types.js';
import { PulseEventEnvelope } from '../../types/index.js';

export interface BenchmarkClient {
  userId: string;
  ws: WebSocket;
  roomId: string;
}

export class BroadcastProfile {
  private readonly config: BenchmarkConfig;
  private readonly aggregator: StatsAggregator;
  private readonly clients: BenchmarkClient[] = [];
  private isAborted: boolean = false;

  constructor(config: BenchmarkConfig, aggregator: StatsAggregator) {
    this.config = config;
    this.aggregator = aggregator;
  }

  public getClientCount(): number {
    return this.clients.length;
  }

  public async execute(): Promise<void> {
    const { connections, rooms, target, authSecret, durationSec, messageRate } = this.config;
    const auth = new Authenticator(authSecret);

    // 1. Establish connections
    for (let i = 0; i < connections && !this.isAborted; i++) {
      const userId = `broadcaster-${i + 1}`;
      const roomId = `room-${(i % rooms) + 1}`;
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

        // Set up message listener
        ws.on('message', (data: Buffer | string) => {
          try {
            const parsed: PulseEventEnvelope = JSON.parse(data.toString());
            if (parsed.type === 'ROOM_MESSAGE') {
              const payload = parsed.payload as any;
              if (payload && payload.sentAtHr) {
                const latencyMs = Number(process.hrtime.bigint() - BigInt(payload.sentAtHr)) / 1e6;
                this.aggregator.recordReceived(1, latencyMs);
              } else {
                this.aggregator.recordReceived(1);
              }
            }
          } catch {
            // Ignore parse errors on telemetry listener
          }
        });

        this.clients.push({ userId, ws, roomId });
      } catch (err) {
        this.aggregator.recordError(`Connection ${userId} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (this.clients.length === 0 || this.isAborted) {
      return;
    }

    // 2. Join rooms
    for (const client of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        const joinMsg: PulseEventEnvelope = {
          eventId: generateUUIDv7(),
          type: 'ROOM_JOIN',
          timestamp: Date.now(),
          senderId: client.userId,
          target: { roomId: client.roomId },
          payload: { roomId: client.roomId }
        };
        client.ws.send(JSON.stringify(joinMsg));
      }
    }

    // Give server a brief moment to process all room joins
    await new Promise((r) => setTimeout(r, 100));

    // 3. Generate broadcast traffic
    // Choose 1 sender per room (or proportional senders)
    const senders: BenchmarkClient[] = [];
    for (let r = 1; r <= rooms; r++) {
      const roomClient = this.clients.find((c) => c.roomId === `room-${r}`);
      if (roomClient) {
        senders.push(roomClient);
      }
    }

    const intervalMs = Math.max(10, Math.floor(1000 / messageRate));
    const startTime = Date.now();
    const endTime = startTime + durationSec * 1000;

    while (Date.now() < endTime && !this.isAborted) {
      for (const sender of senders) {
        if (sender.ws.readyState === WebSocket.OPEN) {
          const roomMessage: PulseEventEnvelope = {
            eventId: generateUUIDv7(),
            type: 'ROOM_MESSAGE',
            timestamp: Date.now(),
            senderId: sender.userId,
            target: { roomId: sender.roomId },
            payload: {
              text: 'Pulse empirical benchmark broadcast frame',
              sentAtHr: process.hrtime.bigint().toString()
            }
          };

          sender.ws.send(JSON.stringify(roomMessage));
          this.aggregator.recordSent(1);
        }
      }

      await new Promise((r) => setTimeout(r, intervalMs));
    }

    // Drain remaining in-flight deliveries
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
