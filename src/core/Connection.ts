import { WebSocket } from 'ws';
import { ConnectionContext } from '../types/index.js';
import { generateUUIDv7 } from '../utils/uuidv7.js';
import { logger } from '../utils/logger.js';

export class Connection {
  public readonly connectionId: string;
  public readonly userId: string;
  public readonly roles: string[];
  public readonly connectedAt: number;
  public lastSeenAt: number;
  public lastSeenSeq: number = 0;
  public readonly socket: WebSocket;
  public readonly remoteAddress: string;
  public readonly maxBufferedAmountBytes: number;
  private readonly rooms: Set<string> = new Set();
  private isCleanedUp: boolean = false;

  constructor(options: {
    connectionId?: string;
    userId: string;
    roles?: string[];
    socket: WebSocket;
    remoteAddress?: string;
    maxBufferedAmountBytes?: number;
  }) {
    this.connectionId = options.connectionId ?? generateUUIDv7();
    this.userId = options.userId;
    this.roles = options.roles ?? ['user'];
    this.socket = options.socket;
    this.remoteAddress = options.remoteAddress ?? 'unknown';
    this.maxBufferedAmountBytes = options.maxBufferedAmountBytes ?? 1024 * 1024;
    this.connectedAt = Date.now();
    this.lastSeenAt = this.connectedAt;
  }

  public touch(): void {
    this.lastSeenAt = Date.now();
  }

  public send(data: string | object): boolean {
    if (this.socket.readyState !== WebSocket.OPEN) {
      logger.warn('Attempted to send frame over unready socket', {
        component: 'Connection',
        event: 'SEND_SKIPPED',
        connectionId: this.connectionId,
        userId: this.userId,
        readyState: this.socket.readyState
      });
      return false;
    }

    if (this.socket.bufferedAmount > this.maxBufferedAmountBytes) {
      logger.warn('Connection exceeded maximum bufferedAmount; closing slow consumer', {
        component: 'Connection',
        event: 'SLOW_CONSUMER_DROP',
        connectionId: this.connectionId,
        userId: this.userId,
        bufferedAmount: this.socket.bufferedAmount,
        maxBufferedAmountBytes: this.maxBufferedAmountBytes
      });
      this.close(1008, 'Policy Violation: Buffer overflow / slow consumer');
      return false;
    }

    try {
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      this.socket.send(payload);
      return true;
    } catch (err) {
      logger.error('Failed to send data frame over socket', {
        component: 'Connection',
        event: 'SEND_ERROR',
        connectionId: this.connectionId,
        userId: this.userId,
        error: err instanceof Error ? err.message : String(err)
      });
      return false;
    }
  }

  public close(code: number = 1000, reason: string = 'Normal Closure'): void {
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      try {
        this.socket.close(code, reason);
      } catch (err) {
        logger.error('Error closing socket', {
          component: 'Connection',
          event: 'CLOSE_ERROR',
          connectionId: this.connectionId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  public joinRoom(roomId: string): void {
    this.rooms.add(roomId);
  }

  public leaveRoom(roomId: string): void {
    this.rooms.delete(roomId);
  }

  public hasRoom(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  public getRooms(): string[] {
    return Array.from(this.rooms);
  }

  public getContext(): ConnectionContext {
    return {
      connectionId: this.connectionId,
      userId: this.userId,
      roles: [...this.roles],
      connectedAt: this.connectedAt,
      lastSeenAt: this.lastSeenAt,
      lastSeenSeq: this.lastSeenSeq
    };
  }

  public markCleanedUp(): void {
    this.isCleanedUp = true;
  }

  public getIsCleanedUp(): boolean {
    return this.isCleanedUp;
  }

  public isAlive(): boolean {
    return !this.isCleanedUp && this.socket.readyState === WebSocket.OPEN;
  }
}
