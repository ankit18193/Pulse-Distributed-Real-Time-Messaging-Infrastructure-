import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { PulseEventEnvelope, EventType } from '../types/index.js';
import { generateUUIDv7 } from '../utils/uuidv7.js';
import { logger } from '../utils/logger.js';

export type ClientSessionState =
  | 'CONNECTED'
  | 'DISCONNECTED'
  | 'RECONNECTING_BACKOFF'
  | 'CONNECTING'
  | 'AUTHENTICATING'
  | 'RESUBSCRIBING_ROOMS'
  | 'FLUSH_RETRY_QUEUE';

export interface InFlightEntry {
  envelope: PulseEventEnvelope;
  retries: number;
  timer: NodeJS.Timeout;
  resolve: (ack: PulseEventEnvelope) => void;
  reject: (err: Error) => void;
}

export interface PulseClientSessionOptions {
  serverUrl: string;
  token: string;
  userId: string;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxRetries?: number;
  ackTimeoutMs?: number;
  queueCapacity?: number;
  randomSource?: () => number;
  autoReconnect?: boolean;
}

export class PulseClientSession extends EventEmitter {
  private readonly serverUrl: string;
  private readonly token: string;
  public readonly userId: string;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxRetries: number;
  private readonly ackTimeoutMs: number;
  private readonly queueCapacity: number;
  private readonly randomSource: () => number;
  private readonly autoReconnect: boolean;

  private state: ClientSessionState = 'DISCONNECTED';
  private ws: WebSocket | null = null;
  private currentSeq: number = 0;
  private lastBackoffDelay: number = 0;
  private reconnectAttempt: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectionTimeoutTimer: NodeJS.Timeout | null = null;
  private isExplicitlyClosed: boolean = false;

  private readonly desiredRooms: Set<string> = new Set();
  private readonly inFlightQueue: Map<string, InFlightEntry> = new Map();

  constructor(options: PulseClientSessionOptions) {
    super();
    this.serverUrl = options.serverUrl;
    this.token = options.token;
    this.userId = options.userId;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 10000;
    this.maxRetries = options.maxRetries ?? 3;
    this.ackTimeoutMs = options.ackTimeoutMs ?? 3000;
    this.queueCapacity = options.queueCapacity ?? 100;
    this.randomSource = options.randomSource ?? Math.random;
    this.autoReconnect = options.autoReconnect ?? true;
  }

  public getState(): ClientSessionState {
    return this.state;
  }

  public getInFlightCount(): number {
    return this.inFlightQueue.size;
  }

  public getDesiredRooms(): string[] {
    return Array.from(this.desiredRooms);
  }

  public getCurrentSeq(): number {
    return this.currentSeq;
  }

  private setState(newState: ClientSessionState): void {
    const oldState = this.state;
    this.state = newState;
    this.emit('stateChange', { oldState, newState });
  }

  /**
   * Computes decorrelated jitter backoff delay.
   * Formula: T_wait = min(maxDelay, random(baseDelay, previousDelay * 3))
   */
  public computeNextBackoffDelay(): number {
    if (this.reconnectAttempt === 0 || this.lastBackoffDelay === 0) {
      const rand = this.randomSource();
      const delay = this.baseDelayMs + Math.floor(rand * this.baseDelayMs);
      this.lastBackoffDelay = Math.min(this.maxDelayMs, delay);
      return this.lastBackoffDelay;
    }

    const min = this.baseDelayMs;
    const max = Math.min(this.maxDelayMs, this.lastBackoffDelay * 3);
    const rand = this.randomSource();
    const delay = min + Math.floor(rand * (max - min));
    this.lastBackoffDelay = Math.min(this.maxDelayMs, Math.max(min, delay));
    return this.lastBackoffDelay;
  }

  public resetBackoff(): void {
    this.reconnectAttempt = 0;
    this.lastBackoffDelay = 0;
  }

  /**
   * Connects or reconnects the client to the Pulse server.
   */
  public async connect(): Promise<void> {
    this.isExplicitlyClosed = false;
    this.clearReconnectTimer();

    return new Promise<void>((resolve, reject) => {
      this.setState('CONNECTING');

      const urlWithToken = `${this.serverUrl}${
        this.serverUrl.includes('?') ? '&' : '?'
      }token=${encodeURIComponent(this.token)}`;

      try {
        this.ws = new WebSocket(urlWithToken);
      } catch (err) {
        this.setState('DISCONNECTED');
        this.handleDisconnectOrError();
        return reject(err);
      }

      this.clearConnectionTimeout();
      this.connectionTimeoutTimer = setTimeout(() => {
        if (this.state === 'CONNECTING' || this.state === 'AUTHENTICATING') {
          this.ws?.terminate();
          this.setState('DISCONNECTED');
          this.handleDisconnectOrError();
          reject(new Error('Connection attempt timed out'));
        }
      }, 5000);
      if (this.connectionTimeoutTimer.unref) {
        this.connectionTimeoutTimer.unref();
      }

      this.ws.on('open', () => {
        this.setState('AUTHENTICATING');
      });

      this.ws.on('message', async (data: Buffer | string) => {
        try {
          const envelope = JSON.parse(data.toString()) as PulseEventEnvelope;
          await this.handleIncomingEnvelope(envelope, resolve, this.connectionTimeoutTimer || undefined);
        } catch {
          // Ignore parse errors on raw messages
        }
      });

      this.ws.on('close', (code, reason) => {
        this.clearConnectionTimeout();
        const wasConnected = this.state === 'CONNECTED';
        this.setState('DISCONNECTED');
        this.emit('close', { code, reason: reason.toString() });

        if (wasConnected && !this.isExplicitlyClosed) {
          this.handleDisconnectOrError();
        }
      });

      this.ws.on('error', (err) => {
        if (this.listenerCount('error') > 0) {
          this.emit('error', err);
        } else {
          logger.debug('Client session socket error', {
            component: 'PulseClientSession',
            error: err.message
          });
        }
        if (this.state === 'CONNECTING') {
          this.clearConnectionTimeout();
          this.setState('DISCONNECTED');
          this.handleDisconnectOrError();
          reject(err);
        }
      });
    });
  }

  private async handleIncomingEnvelope(
    envelope: PulseEventEnvelope,
    initialConnectResolve?: () => void,
    connectionTimeoutTimer?: NodeJS.Timeout
  ): Promise<void> {
    // 1. Initial Handshake completion
    if (envelope.type === 'SYS_CONNECT_ACK') {
      if (connectionTimeoutTimer) {
        clearTimeout(connectionTimeoutTimer);
      }
      this.resetBackoff();

      // If we have previously desired rooms, batch resubscribe
      if (this.desiredRooms.size > 0) {
        await this.resubscribeRooms();
      } else {
        this.flushRetryQueue();
        this.setState('CONNECTED');
      }

      if (initialConnectResolve) {
        initialConnectResolve();
      }
      this.emit('connected', envelope);
      return;
    }

    // 2. Handle Delivery ACK resolution
    if (
      envelope.type === 'DELIVERY_ACK' ||
      envelope.type === 'ROOM_JOIN_ACK' ||
      envelope.type === 'ROOM_BATCH_JOIN_ACK' ||
      envelope.type === 'ROOM_LEAVE_ACK'
    ) {
      const corrId = envelope.correlationId;
      if (corrId && this.inFlightQueue.has(corrId)) {
        const entry = this.inFlightQueue.get(corrId)!;
        clearTimeout(entry.timer);
        this.inFlightQueue.delete(corrId);
        entry.resolve(envelope);
      }
    }

    // 3. Emit application message event
    this.emit('message', envelope);
  }

  private async resubscribeRooms(): Promise<void> {
    this.setState('RESUBSCRIBING_ROOMS');
    const rooms = Array.from(this.desiredRooms);

    try {
      await this.sendEnvelope({
        eventId: generateUUIDv7(),
        type: 'ROOM_BATCH_JOIN',
        timestamp: Date.now(),
        senderId: this.userId,
        payload: { rooms },
        ackRequired: true
      });
    } catch (err) {
      logger.error('Failed to batch resubscribe rooms on reconnect', {
        component: 'PulseClientSession',
        error: String(err)
      });
    }

    this.flushRetryQueue();
    this.setState('CONNECTED');
  }

  private flushRetryQueue(): void {
    this.setState('FLUSH_RETRY_QUEUE');
    if (this.inFlightQueue.size === 0) {
      return;
    }

    logger.info('Flushing unacknowledged frames on reconnect', {
      component: 'PulseClientSession',
      inFlightCount: this.inFlightQueue.size
    });

    for (const [corrId, entry] of this.inFlightQueue.entries()) {
      clearTimeout(entry.timer);
      this.transmitFrame(entry.envelope);
      this.armAckTimeout(corrId, entry);
    }
  }

  private handleDisconnectOrError(): void {
    if (this.isExplicitlyClosed || !this.autoReconnect) {
      return;
    }

    this.reconnectAttempt++;
    const delay = this.computeNextBackoffDelay();

    logger.info('Scheduling client reconnect with decorrelated jitter', {
      component: 'PulseClientSession',
      attempt: this.reconnectAttempt,
      delayMs: delay
    });

    this.setState('RECONNECTING_BACKOFF');
    this.clearReconnectTimer();

    this.reconnectTimer = setTimeout(() => {
      if (!this.isExplicitlyClosed) {
        this.connect().catch(() => {
          // Reconnect error handled in state machine
        });
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearConnectionTimeout(): void {
    if (this.connectionTimeoutTimer) {
      clearTimeout(this.connectionTimeoutTimer);
      this.connectionTimeoutTimer = null;
    }
  }

  /**
   * Sends an envelope over the WebSocket, managing in-flight retry tracking if ackRequired is set.
   */
  public async sendEnvelope(
    envelopeOptions: Omit<PulseEventEnvelope, 'seq'> & { seq?: number }
  ): Promise<PulseEventEnvelope | void> {
    if (this.inFlightQueue.size >= this.queueCapacity) {
      throw new Error('BUFFER_FULL: Client in-flight queue capacity reached');
    }

    this.currentSeq =
      envelopeOptions.seq !== undefined ? envelopeOptions.seq : this.currentSeq + 1;
    const correlationId = envelopeOptions.correlationId ?? generateUUIDv7();

    const envelope: PulseEventEnvelope = {
      ...envelopeOptions,
      seq: this.currentSeq,
      correlationId
    };

    if (!envelope.ackRequired) {
      this.transmitFrame(envelope);
      return;
    }

    return new Promise<PulseEventEnvelope>((resolve, reject) => {
      const entry: InFlightEntry = {
        envelope,
        retries: 0,
        timer: null as unknown as NodeJS.Timeout,
        resolve,
        reject
      };

      this.armAckTimeout(correlationId, entry);
      this.inFlightQueue.set(correlationId, entry);

      this.transmitFrame(envelope);
    });
  }

  private armAckTimeout(correlationId: string, entry: InFlightEntry): void {
    entry.timer = setTimeout(() => {
      if (entry.retries < this.maxRetries) {
        entry.retries++;
        logger.info('ACK timeout expired; retransmitting unacknowledged frame', {
          component: 'PulseClientSession',
          eventId: entry.envelope.eventId,
          correlationId,
          retryCount: entry.retries
        });

        // Retransmit using identical eventId, correlationId, and payload
        this.transmitFrame(entry.envelope);
        this.armAckTimeout(correlationId, entry);
      } else {
        logger.warn('ACK retries exhausted; surfacing delivery timeout', {
          component: 'PulseClientSession',
          eventId: entry.envelope.eventId,
          correlationId,
          maxRetries: this.maxRetries
        });

        clearTimeout(entry.timer);
        this.inFlightQueue.delete(correlationId);
        entry.reject(
          new Error(
            `DELIVERY_TIMEOUT: Acknowledgement not received after ${this.maxRetries} retries`
          )
        );
      }
    }, this.ackTimeoutMs);
  }

  private transmitFrame(envelope: PulseEventEnvelope): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(envelope));
    }
  }

  public async joinRoom(roomId: string): Promise<PulseEventEnvelope> {
    this.desiredRooms.add(roomId);
    const ack = await this.sendEnvelope({
      eventId: generateUUIDv7(),
      type: 'ROOM_JOIN',
      timestamp: Date.now(),
      senderId: this.userId,
      target: { roomId },
      payload: {},
      ackRequired: true
    });
    return ack as PulseEventEnvelope;
  }

  public async joinRooms(rooms: string[]): Promise<PulseEventEnvelope> {
    for (const r of rooms) {
      this.desiredRooms.add(r);
    }
    const ack = await this.sendEnvelope({
      eventId: generateUUIDv7(),
      type: 'ROOM_BATCH_JOIN',
      timestamp: Date.now(),
      senderId: this.userId,
      payload: { rooms },
      ackRequired: true
    });
    return ack as PulseEventEnvelope;
  }

  public async leaveRoom(roomId: string): Promise<PulseEventEnvelope> {
    this.desiredRooms.delete(roomId);
    const ack = await this.sendEnvelope({
      eventId: generateUUIDv7(),
      type: 'ROOM_LEAVE',
      timestamp: Date.now(),
      senderId: this.userId,
      target: { roomId },
      payload: {},
      ackRequired: true
    });
    return ack as PulseEventEnvelope;
  }

  public async sendRoomMessage(
    roomId: string,
    payload: Record<string, unknown>,
    ackRequired: boolean = true
  ): Promise<PulseEventEnvelope | void> {
    return this.sendEnvelope({
      eventId: generateUUIDv7(),
      type: 'ROOM_MESSAGE',
      timestamp: Date.now(),
      senderId: this.userId,
      target: { roomId },
      payload,
      ackRequired
    });
  }

  public async sendDirectMessage(
    recipientId: string,
    payload: Record<string, unknown>,
    ackRequired: boolean = true
  ): Promise<PulseEventEnvelope | void> {
    return this.sendEnvelope({
      eventId: generateUUIDv7(),
      type: 'DIRECT_MESSAGE',
      timestamp: Date.now(),
      senderId: this.userId,
      target: { recipientId },
      payload,
      ackRequired
    });
  }

  public async disconnect(): Promise<void> {
    this.isExplicitlyClosed = true;
    this.clearReconnectTimer();
    this.clearConnectionTimeout();

    // Clean up all in-flight timers
    for (const entry of this.inFlightQueue.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('SESSION_CLOSED: Client session was disconnected'));
    }
    this.inFlightQueue.clear();

    if (this.ws) {
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        await new Promise<void>((resolve) => {
          this.ws!.once('close', () => resolve());
          this.ws!.close(1000, 'Client disconnect');
          setTimeout(() => resolve(), 200);
        });
      }
      this.ws = null;
    }

    this.setState('DISCONNECTED');
  }
}
