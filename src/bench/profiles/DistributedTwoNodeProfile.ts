/**
 * Pulse — Distributed Real-Time Messaging Infrastructure
 * Two-Node Distributed Workload Benchmark Profile
 *
 * Topology:
 * Senders -> Pulse Node 1 -> Redis Pub/Sub -> Pulse Node 2 -> Receivers
 */

import { WebSocket } from 'ws';
import { Authenticator } from '../../auth/Authenticator.js';
import { generateUUIDv7 } from '../../utils/uuidv7.js';
import { StatsAggregator } from '../StatsAggregator.js';
import { PercentileStats } from '../types.js';
import { PulseEventEnvelope } from '../../types/index.js';

export interface DistributedTwoNodeConfig {
  node1Target: string;
  node2Target: string;
  connectionsPerNode: number;
  durationSec: number;
  messageRate: number;
  rooms: number;
  authSecret: string;
}

export class DistributedTwoNodeProfile {
  private readonly config: DistributedTwoNodeConfig;
  private readonly aggregator: StatsAggregator;
  private readonly senders: WebSocket[] = [];
  private readonly receivers: WebSocket[] = [];
  private readonly crossNodeLatenciesMs: number[] = [];
  private isAborted: boolean = false;

  constructor(config: DistributedTwoNodeConfig, aggregator: StatsAggregator) {
    this.config = config;
    this.aggregator = aggregator;
  }

  public getSenderCount(): number {
    return this.senders.length;
  }

  public getReceiverCount(): number {
    return this.receivers.length;
  }

  public getCrossNodeTransitStats(): PercentileStats {
    return StatsAggregator.calculatePercentiles(this.crossNodeLatenciesMs);
  }

  public async execute(): Promise<void> {
    const {
      node1Target,
      node2Target,
      connectionsPerNode,
      durationSec,
      messageRate,
      rooms,
      authSecret
    } = this.config;

    const auth = new Authenticator(authSecret);

    // 1. Establish receivers on Node 2
    for (let i = 0; i < connectionsPerNode && !this.isAborted; i++) {
      const userId = `node2-rx-${i + 1}`;
      const roomId = `room-${(i % rooms) + 1}`;
      const token = auth.generateToken({
        userId,
        roles: ['user'],
        expiresInMs: (durationSec + 60) * 1000
      });

      const separator = node2Target.includes('?') ? '&' : '?';
      const url = `${node2Target}${separator}token=${encodeURIComponent(token)}`;

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

        // Set up cross-node message listener
        ws.on('message', (data: Buffer | string) => {
          try {
            const parsed: PulseEventEnvelope = JSON.parse(data.toString());
            if (parsed.type === 'ROOM_MESSAGE') {
              const payload = parsed.payload as any;
              if (payload && payload.sentAtHr) {
                const e2eLatencyMs = Number(process.hrtime.bigint() - BigInt(payload.sentAtHr)) / 1e6;
                this.aggregator.recordReceived(1, e2eLatencyMs);
              } else {
                this.aggregator.recordReceived(1);
              }

              // Characterize cross-node transit latency if stamped
              if (typeof parsed.originTimestampMs === 'number') {
                const transitMs = Math.max(0, Date.now() - parsed.originTimestampMs);
                this.crossNodeLatenciesMs.push(transitMs);
              }
            }
          } catch {
            // Ignore parse errors on telemetry listener
          }
        });

        // Join room
        const joinMsg: PulseEventEnvelope = {
          eventId: generateUUIDv7(),
          type: 'ROOM_JOIN',
          timestamp: Date.now(),
          senderId: userId,
          target: { roomId },
          payload: { roomId }
        };
        ws.send(JSON.stringify(joinMsg));

        this.receivers.push(ws);
      } catch (err) {
        this.aggregator.recordError(`Receiver ${userId} connection failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 2. Establish senders on Node 1
    for (let i = 0; i < connectionsPerNode && !this.isAborted; i++) {
      const userId = `node1-tx-${i + 1}`;
      const roomId = `room-${(i % rooms) + 1}`;
      const token = auth.generateToken({
        userId,
        roles: ['user'],
        expiresInMs: (durationSec + 60) * 1000
      });

      const separator = node1Target.includes('?') ? '&' : '?';
      const url = `${node1Target}${separator}token=${encodeURIComponent(token)}`;

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

        // Join room
        const joinMsg: PulseEventEnvelope = {
          eventId: generateUUIDv7(),
          type: 'ROOM_JOIN',
          timestamp: Date.now(),
          senderId: userId,
          target: { roomId },
          payload: { roomId }
        };
        ws.send(JSON.stringify(joinMsg));

        this.senders.push(ws);
      } catch (err) {
        this.aggregator.recordError(`Sender ${userId} connection failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Stabilization delay for Redis subscriptions
    await new Promise((r) => setTimeout(r, 150));

    if (this.senders.length === 0 || this.receivers.length === 0 || this.isAborted) {
      return;
    }

    // 3. Generate cross-node room traffic from Node 1
    const intervalMs = Math.max(10, Math.floor(1000 / messageRate));
    const startTime = Date.now();
    const endTime = startTime + durationSec * 1000;

    while (Date.now() < endTime && !this.isAborted) {
      for (let i = 0; i < this.senders.length; i++) {
        const sender = this.senders[i];
        const roomId = `room-${(i % rooms) + 1}`;

        if (sender.readyState === WebSocket.OPEN) {
          const roomMessage: PulseEventEnvelope = {
            eventId: generateUUIDv7(),
            type: 'ROOM_MESSAGE',
            timestamp: Date.now(),
            senderId: `node1-tx-${i + 1}`,
            target: { roomId },
            payload: {
              text: 'Cross-node benchmark payload',
              sentAtHr: process.hrtime.bigint().toString()
            }
          };

          sender.send(JSON.stringify(roomMessage));
          this.aggregator.recordSent(1);
        }
      }

      await new Promise((r) => setTimeout(r, intervalMs));
    }

    // Drain remaining cross-node deliveries
    await new Promise((r) => setTimeout(r, 300));
  }

  public abort(): void {
    this.isAborted = true;
    this.cleanup();
  }

  public cleanup(): void {
    for (const ws of [...this.senders, ...this.receivers]) {
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1000, 'Distributed benchmark completed');
        }
      } catch {
        // Ignore teardown errors
      }
    }
    this.senders.length = 0;
    this.receivers.length = 0;
  }
}
