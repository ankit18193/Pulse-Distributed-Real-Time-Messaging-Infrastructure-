import crypto from 'crypto';
import { ConnectionManager } from './ConnectionManager.js';
import { PulseEventEnvelope } from '../types/index.js';
import { logger } from '../utils/logger.js';

export class HeartbeatManager {
  private readonly connectionManager: ConnectionManager;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private timer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

  constructor(options: {
    connectionManager: ConnectionManager;
    intervalMs: number;
    timeoutMs: number;
  }) {
    this.connectionManager = options.connectionManager;
    this.intervalMs = options.intervalMs;
    this.timeoutMs = options.timeoutMs;
  }

  public start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.timer = setInterval(() => {
      this.checkHeartbeats();
    }, this.intervalMs);

    // Allow Node process to exit if only heartbeat timer remains
    if (this.timer.unref) {
      this.timer.unref();
    }

    logger.debug('Heartbeat manager started', {
      component: 'HeartbeatManager',
      intervalMs: this.intervalMs,
      timeoutMs: this.timeoutMs
    });
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;

    logger.debug('Heartbeat manager stopped', {
      component: 'HeartbeatManager'
    });
  }

  public checkHeartbeats(): void {
    const now = Date.now();
    const connections = this.connectionManager.getAllConnections();

    for (const conn of connections) {
      const elapsedSinceLastSeen = now - conn.lastSeenAt;

      // Stale connection detection: no activity or pong within interval + timeout
      if (elapsedSinceLastSeen > this.intervalMs + this.timeoutMs) {
        logger.warn('Dead connection detected via heartbeat timeout; reaping socket', {
          component: 'HeartbeatManager',
          event: 'HEARTBEAT_TIMEOUT',
          connectionId: conn.connectionId,
          userId: conn.userId,
          elapsedMs: elapsedSinceLastSeen,
          thresholdMs: this.intervalMs + this.timeoutMs
        });

        conn.close(1002, 'Heartbeat timeout: connection unresponsive');
        continue;
      }

      // If connection has been quiet longer than interval, send ping
      if (elapsedSinceLastSeen >= this.intervalMs) {
        const pingEnvelope: PulseEventEnvelope = {
          eventId: crypto.randomUUID(),
          type: 'SYS_PING',
          timestamp: now,
          senderId: 'system',
          payload: {
            timestamp: now
          }
        };

        conn.send(pingEnvelope);
      }
    }
  }

  public getIsRunning(): boolean {
    return this.isRunning;
  }
}
