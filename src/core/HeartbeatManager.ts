import { ConnectionManager } from './ConnectionManager.js';
import { PulseEventEnvelope } from '../types/index.js';
import { generateUUIDv7 } from '../utils/uuidv7.js';
import { logger } from '../utils/logger.js';

export class HeartbeatManager {
  private readonly connectionManager: ConnectionManager;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly sweepTickMs: number;
  private timer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

  constructor(options: {
    connectionManager: ConnectionManager;
    intervalMs: number;
    timeoutMs: number;
    sweepTickMs?: number;
  }) {
    this.connectionManager = options.connectionManager;
    this.intervalMs = options.intervalMs;
    this.timeoutMs = options.timeoutMs;
    // Granular sweep tick rate: half of the smallest threshold (min 20ms for tests)
    this.sweepTickMs =
      options.sweepTickMs ??
      Math.max(20, Math.floor(Math.min(this.intervalMs, this.timeoutMs) / 2));
  }

  public getSweepTickMs(): number {
    return this.sweepTickMs;
  }

  public start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.timer = setInterval(() => {
      this.checkHeartbeats();
    }, this.sweepTickMs);

    // Allow Node process to exit if only heartbeat timer remains
    if (this.timer.unref) {
      this.timer.unref();
    }

    logger.debug('Heartbeat manager started with sub-tick sweep scheduling', {
      component: 'HeartbeatManager',
      intervalMs: this.intervalMs,
      timeoutMs: this.timeoutMs,
      sweepTickMs: this.sweepTickMs
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
        if (conn.isHeartbeatTimedOut) {
          // Half-open socket failed to close via handshake; forcibly terminate TCP handle
          conn.terminate();
          continue;
        }

        logger.warn('Dead connection detected via heartbeat timeout; reaping socket', {
          component: 'HeartbeatManager',
          event: 'HEARTBEAT_TIMEOUT',
          connectionId: conn.connectionId,
          userId: conn.userId,
          elapsedMs: elapsedSinceLastSeen,
          thresholdMs: this.intervalMs + this.timeoutMs
        });

        conn.isHeartbeatTimedOut = true;
        conn.close(1002, 'Heartbeat timeout: connection unresponsive');

        // Schedule fallback termination if peer is half-open / blackholed and fails to handshake close
        const fallbackTimer = setTimeout(() => {
          if ((conn as any).socket?.readyState === 2 /* CLOSING */ || (conn as any).socket?.readyState === 1 /* OPEN */) {
            conn.terminate();
          }
        }, 150);
        if (typeof fallbackTimer.unref === 'function') {
          fallbackTimer.unref();
        }
        continue;
      }

      // If connection has been quiet longer than interval, send ping
      if (elapsedSinceLastSeen >= this.intervalMs) {
        const pingEnvelope: PulseEventEnvelope = {
          eventId: generateUUIDv7(),
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
