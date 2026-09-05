/**
 * Pulse — Distributed Real-Time Messaging Infrastructure
 * Slow Consumer / Backpressure Benchmark Profile
 *
 * Verifies that:
 * 1. A deliberately slow consumer accumulates server buffer and is closed with RFC 6455 code 1008
 * 2. Healthy consumers continue operating normally without interruption
 */

import { WebSocket } from 'ws';
import { Authenticator } from '../../auth/Authenticator.js';
import { generateUUIDv7 } from '../../utils/uuidv7.js';
import { StatsAggregator } from '../StatsAggregator.js';
import { BenchmarkConfig } from '../types.js';
import { PulseEventEnvelope } from '../../types/index.js';

export class BackpressureProfile {
  private readonly config: BenchmarkConfig;
  private readonly aggregator: StatsAggregator;
  private senderWs: WebSocket | null = null;
  private healthyWs: WebSocket | null = null;
  private slowWs: WebSocket | null = null;

  private slowConsumerClosed: boolean = false;
  private slowConsumerCloseCode: number = 0;
  private healthyConsumerClosed: boolean = false;
  private healthyReceivedCount: number = 0;
  private isAborted: boolean = false;

  constructor(config: BenchmarkConfig, aggregator: StatsAggregator) {
    this.config = config;
    this.aggregator = aggregator;
  }

  public isSlowConsumerEvicted(): boolean {
    return this.slowConsumerClosed && this.slowConsumerCloseCode === 1008;
  }

  public getSlowConsumerCloseCode(): number {
    return this.slowConsumerCloseCode;
  }

  public getHealthyReceivedCount(): number {
    return this.healthyReceivedCount;
  }

  public isHealthyConsumerActive(): boolean {
    return this.healthyWs !== null && this.healthyWs.readyState === WebSocket.OPEN && !this.healthyConsumerClosed;
  }

  public async execute(): Promise<void> {
    const { target, durationSec, authSecret } = this.config;
    const auth = new Authenticator(authSecret);
    const roomId = 'backpressure-bench-room';

    const createWs = (userId: string): Promise<WebSocket> => {
      this.aggregator.recordConnectionAttempt();
      const startHr = process.hrtime.bigint();
      const token = auth.generateToken({
        userId,
        roles: ['user'],
        expiresInMs: (durationSec + 60) * 1000
      });
      const separator = target.includes('?') ? '&' : '?';
      const url = `${target}${separator}token=${encodeURIComponent(token)}`;

      return new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.once('open', () => {
          const latencyMs = Number(process.hrtime.bigint() - startHr) / 1e6;
          this.aggregator.recordConnectionSuccess(latencyMs);
          resolve(ws);
        });
        ws.once('error', (err) => {
          this.aggregator.recordConnectionFailure(err.message);
          reject(err);
        });
      });
    };

    // 1. Connect healthy consumer
    this.healthyWs = await createWs('bench-healthy-consumer');
    this.healthyWs.on('message', (data: Buffer | string) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === 'ROOM_MESSAGE') {
          this.healthyReceivedCount++;
          this.aggregator.recordReceived(1);
        }
      } catch {
        // Ignore parse error
      }
    });
    this.healthyWs.on('close', () => {
      this.healthyConsumerClosed = true;
    });

    // 2. Connect slow consumer
    this.slowWs = await createWs('bench-slow-consumer');
    this.slowWs.on('close', (code) => {
      this.slowConsumerClosed = true;
      this.slowConsumerCloseCode = code;
    });

    // 3. Connect sender
    this.senderWs = await createWs('bench-backpressure-sender');

    // Join all three to the target room
    for (const ws of [this.healthyWs, this.slowWs, this.senderWs]) {
      const joinMsg: PulseEventEnvelope = {
        eventId: generateUUIDv7(),
        type: 'ROOM_JOIN',
        timestamp: Date.now(),
        senderId: 'bench-user',
        target: { roomId },
        payload: { roomId }
      };
      ws.send(JSON.stringify(joinMsg));
    }

    // Brief stabilization pause for room joins
    await new Promise((r) => setTimeout(r, 100));

    // Deliberately throttle/pause the slow consumer's underlying socket stream to build up backpressure
    const slowSocket = (this.slowWs as any)._socket;
    if (slowSocket && typeof slowSocket.pause === 'function') {
      slowSocket.pause();
    }

    // 4. Generate high-throughput traffic with substantial payload to trigger bufferedAmount overflow
    // Generates 4KB frames in rapid bursts to fill the TCP window on the paused slow consumer
    const largeChunk = 'X'.repeat(4096);
    const frameCount = 120;

    for (let i = 0; i < frameCount && !this.isAborted; i++) {
      if (this.senderWs.readyState === WebSocket.OPEN) {
        const frame: PulseEventEnvelope = {
          eventId: generateUUIDv7(),
          type: 'ROOM_MESSAGE',
          timestamp: Date.now(),
          senderId: 'bench-backpressure-sender',
          target: { roomId },
          payload: {
            chunk: largeChunk,
            sentAtHr: process.hrtime.bigint().toString()
          }
        };

        this.senderWs.send(JSON.stringify(frame));
        this.aggregator.recordSent(1);
      }

      // Small yield every 5 frames so event loop dispatches frames to consumers
      if (i % 5 === 0) {
        await new Promise((r) => setTimeout(r, 5));
      }
    }

    // Allow server to process frames and detect backpressure threshold overflow
    await new Promise((r) => setTimeout(r, 200));

    // Resume reading on slow consumer so it reads the server's close frame
    if (slowSocket && typeof slowSocket.resume === 'function') {
      slowSocket.resume();
    }

    // Wait for close event to propagate to client
    const closeDeadline = Date.now() + 1000;
    while (!this.slowConsumerClosed && Date.now() < closeDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  public abort(): void {
    this.isAborted = true;
    this.cleanup().catch(() => {});
  }

  public async cleanup(): Promise<void> {
    const sockets = [this.healthyWs, this.slowWs, this.senderWs];
    for (const ws of sockets) {
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        try {
          ws.close(1000, 'Backpressure test finished');
        } catch {
          // Ignore close errors
        }
      }
    }
    this.healthyWs = null;
    this.slowWs = null;
    this.senderWs = null;
    await new Promise((r) => setTimeout(r, 50));
  }
}
