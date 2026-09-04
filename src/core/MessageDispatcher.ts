import { EventEmitter } from 'events';
import { Connection } from './Connection.js';
import { ConnectionManager } from './ConnectionManager.js';
import { RoomManager } from './RoomManager.js';
import { IdempotencyManager } from './IdempotencyManager.js';
import { EventValidator } from '../events/EventValidator.js';
import { PulseEventEnvelope, PresenceUpdatePayload } from '../types/index.js';
import { RedisPubSubManager } from '../redis/RedisPubSubManager.js';
import type { PresenceManager } from '../redis/PresenceManager.js';
import { extractRoomId, extractUserId } from '../redis/ChannelRegistry.js';
import { generateUUIDv7 } from '../utils/uuidv7.js';
import { logger } from '../utils/logger.js';

export interface MessageDispatcherOptions {
  connectionManager: ConnectionManager;
  roomManager: RoomManager;
  idempotencyManager?: IdempotencyManager;
  redisPubSubManager?: RedisPubSubManager;
  presenceManager?: PresenceManager;
  instanceId: string;
}

export class MessageDispatcher extends EventEmitter {
  private readonly connectionManager: ConnectionManager;
  private readonly roomManager: RoomManager;
  private readonly idempotencyManager: IdempotencyManager;
  private readonly redisPubSubManager?: RedisPubSubManager;
  private presenceManager?: PresenceManager;
  private readonly instanceId: string;

  constructor(options: MessageDispatcherOptions) {
    super();
    this.connectionManager = options.connectionManager;
    this.roomManager = options.roomManager;
    this.idempotencyManager =
      options.idempotencyManager ?? new IdempotencyManager();
    this.redisPubSubManager = options.redisPubSubManager;
    this.presenceManager = options.presenceManager;
    this.instanceId = options.instanceId;

    if (this.redisPubSubManager) {
      this.redisPubSubManager.onMessage((channel, message) => {
        this.handleInboundRedisEvent(channel, message);
      });
    }
  }

  public getPresenceManager(): PresenceManager | undefined {
    return this.presenceManager;
  }

  public setPresenceManager(presenceManager: PresenceManager): void {
    this.presenceManager = presenceManager;
  }

  public onPresenceUpdate(handler: (envelope: PulseEventEnvelope) => void): void {
    this.on('presence_update', handler);
  }

  public getIdempotencyManager(): IdempotencyManager {
    return this.idempotencyManager;
  }

  public getRedisPubSubManager(): RedisPubSubManager | undefined {
    return this.redisPubSubManager;
  }

  public getInstanceId(): string {
    return this.instanceId;
  }

  /**
   * Processes an inbound event received from a Redis Pub/Sub channel:
   * 1. Validates envelope
   * 2. Suppresses self-echoes (originInstanceId === local instanceId)
   * 3. Performs local idempotency check & suppresses duplicates
   * 4. Delivers to local eligible connections (without applying connection-local seq checks)
   * Returns true if event was processed, false if dropped/suppressed.
   */
  public handleInboundRedisEvent(
    channel: string,
    rawMessage: string | PulseEventEnvelope
  ): boolean {
    let parsed: unknown;

    if (typeof rawMessage === 'string') {
      try {
        parsed = JSON.parse(rawMessage);
      } catch (err) {
        logger.warn('Failed to parse inbound Redis event JSON', {
          component: 'MessageDispatcher',
          channel,
          error: err instanceof Error ? err.message : String(err)
        });
        return false;
      }
    } else {
      parsed = rawMessage;
    }

    const inboundStartTime = Date.now();
    // 1. Validate envelope for distributed delivery
    const validation = EventValidator.validateDistributed(parsed);
    if (!validation.valid || !validation.envelope) {
      logger.warn('Inbound Redis event failed validation', {
        component: 'MessageDispatcher',
        channel,
        error: validation.error?.message
      });
      return false;
    }

    const envelope = validation.envelope;

    // 2. Self-echo suppression: if originInstanceId matches this node, drop immediately
    if (envelope.originInstanceId === this.instanceId) {
      this.redisPubSubManager?.getMetrics?.().recordEchoSuppressed();
      logger.debug('Suppressed Redis self-echo loopback', {
        component: 'MessageDispatcher',
        event: 'SELF_ECHO_SUPPRESSED',
        channel,
        eventId: envelope.eventId,
        originInstanceId: envelope.originInstanceId,
        localInstanceId: this.instanceId
      });
      return false;
    }

    // 3. Local idempotency check: deduplicate inbound Redis events
    const idempCheck = this.idempotencyManager.check(
      envelope.eventId,
      envelope.payload
    );

    if (idempCheck.isDuplicate) {
      this.redisPubSubManager?.getMetrics?.().recordDuplicateSuppressed();
      logger.debug('Suppressed duplicate inbound Redis event', {
        component: 'MessageDispatcher',
        event: 'REDIS_DUPLICATE_SUPPRESSED',
        channel,
        eventId: envelope.eventId,
        hasConflict: idempCheck.hasConflict
      });
      return false;
    }

    // Record in local idempotency cache
    const ack: PulseEventEnvelope = {
      eventId: generateUUIDv7(),
      type: 'DELIVERY_ACK',
      timestamp: Date.now(),
      senderId: 'system',
      payload: {
        targetEventId: envelope.eventId,
        status: 'DISTRIBUTED_ACCEPTED'
      }
    };
    this.idempotencyManager.recordAck(envelope.eventId, ack, envelope.payload);

    // 4. Deliver only to local eligible connections (no connection-local seq checking)
    if (envelope.type === 'ROOM_MESSAGE') {
      const roomId = envelope.target?.roomId || extractRoomId(channel);
      if (!roomId) {
        logger.warn('Inbound Redis room event missing target roomId', {
          component: 'MessageDispatcher',
          channel,
          eventId: envelope.eventId
        });
        return false;
      }

      const memberConnectionIds = this.roomManager.getRoomConnectionIds(roomId);
      let delivered = 0;

      for (const connId of memberConnectionIds) {
        const recipient = this.connectionManager.getConnection(connId);
        if (recipient && recipient.send(envelope)) {
          delivered++;
        }
      }

      this.redisPubSubManager?.getMetrics?.().recordInbound(Date.now() - inboundStartTime);

      logger.debug('Delivered inbound Redis room message to local sockets', {
        component: 'MessageDispatcher',
        roomId,
        eventId: envelope.eventId,
        deliveredCount: delivered
      });

      return true;
    }

    if (envelope.type === 'DIRECT_MESSAGE') {
      const recipientId = envelope.target?.recipientId || extractUserId(channel);
      if (!recipientId) {
        logger.warn('Inbound Redis direct event missing target recipientId', {
          component: 'MessageDispatcher',
          channel,
          eventId: envelope.eventId
        });
        return false;
      }

      const recipientConnections = this.connectionManager.getConnectionsByUserId(recipientId);
      let delivered = 0;

      for (const conn of recipientConnections) {
        if (conn.send(envelope)) {
          delivered++;
        }
      }

      this.redisPubSubManager?.getMetrics?.().recordInbound(Date.now() - inboundStartTime);

      logger.debug('Delivered inbound Redis direct message to local sockets', {
        component: 'MessageDispatcher',
        recipientId,
        eventId: envelope.eventId,
        deliveredCount: delivered
      });

      return true;
    }

    if (envelope.type === 'PRESENCE_UPDATE') {
      const payload = envelope.payload as PresenceUpdatePayload;
      if (!payload || !payload.userId || !payload.status) {
        logger.warn('Inbound Redis presence event missing required payload fields', {
          component: 'MessageDispatcher',
          channel,
          eventId: envelope.eventId
        });
        return false;
      }

      // Stale presence event protection
      if (this.presenceManager) {
        if (this.presenceManager.isStalePresenceEvent(payload.userId, envelope.timestamp)) {
          logger.debug('Dropped stale inbound presence event', {
            component: 'MessageDispatcher',
            userId: payload.userId,
            eventId: envelope.eventId,
            timestamp: envelope.timestamp
          });
          return false;
        }
        this.presenceManager.recordPresenceEvent(payload.userId, envelope.timestamp);
      }

      // Room-scoped fan-out: deliver only to local clients sharing a room with target user
      const deliveredCount = this.deliverRoomScopedPresence(
        payload.userId,
        envelope,
        payload.rooms
      );

      this.redisPubSubManager?.getMetrics?.().recordInbound(Date.now() - inboundStartTime);

      this.emit('presence_update', envelope);

      logger.info('Processed inbound distributed presence event', {
        component: 'MessageDispatcher',
        userId: payload.userId,
        status: payload.status,
        activeConnections: payload.activeConnections,
        originInstanceId: envelope.originInstanceId,
        deliveredCount
      });

      return true;
    }

    return true;
  }

  /**
   * Delivers an inbound PRESENCE_UPDATE event only to local clients that share
   * at least one room with the target user.
   * Clients with no shared rooms do not receive the event (no global broadcast).
   * Multi-device and multi-room connections are deduplicated so each connection
   * receives at most one logical presence frame.
   * Unauthenticated connections never receive presence events.
   */
  public deliverRoomScopedPresence(
    userId: string,
    envelope: PulseEventEnvelope,
    hintRooms?: string[]
  ): number {
    const targetConnectionIds = new Set<string>();

    // 1. If hint rooms are provided in the payload, fan out to local members of those rooms
    if (hintRooms && hintRooms.length > 0) {
      for (const roomId of hintRooms) {
        const memberIds = this.roomManager.getRoomConnectionIds(roomId);
        for (const id of memberIds) {
          targetConnectionIds.add(id);
        }
      }
    } else {
      // 2. Fallback: inspect local rooms where target user is present
      for (const roomId of this.roomManager.getAllRoomIds()) {
        const memberConnIds = this.roomManager.getRoomConnectionIds(roomId);
        const hasTargetUser = memberConnIds.some((connId) => {
          const conn = this.connectionManager.getConnection(connId);
          return conn && conn.userId === userId;
        });

        if (hasTargetUser) {
          for (const id of memberConnIds) {
            targetConnectionIds.add(id);
          }
        }
      }
    }

    let delivered = 0;
    for (const connId of targetConnectionIds) {
      const conn = this.connectionManager.getConnection(connId);
      if (conn) {
        // Enforce: unauthenticated connections must never participate in presence
        if (!conn.userId || conn.userId === 'anonymous') {
          continue;
        }
        if (conn.send(envelope)) {
          delivered++;
        }
      }
    }

    return delivered;
  }

  public dispatchRawMessage(
    sender: Connection,
    rawData: string | Buffer
  ): void {
    sender.touch();

    const validation = EventValidator.validateIncoming(rawData, sender.userId);

    if (!validation.valid || !validation.envelope) {
      logger.warn('Rejected invalid incoming message frame', {
        component: 'MessageDispatcher',
        event: 'INVALID_FRAME',
        connectionId: sender.connectionId,
        userId: sender.userId,
        error: validation.error?.message
      });

      const errorEnvelope: PulseEventEnvelope = {
        eventId: generateUUIDv7(),
        type: 'SYS_ERROR',
        timestamp: Date.now(),
        senderId: 'system',
        correlationId: validation.error?.correlationId,
        payload: {
          code: validation.error?.code || 'INVALID_EVENT',
          message: validation.error?.message || 'Invalid event payload'
        }
      };

      sender.send(errorEnvelope);
      return;
    }

    const envelope = validation.envelope;

    // 2. Check IdempotencyManager for existing eventId/payload BEFORE sequence checking
    if (envelope.type === 'ROOM_MESSAGE' || envelope.type === 'DIRECT_MESSAGE') {
      const idempCheck = this.idempotencyManager.check(
        envelope.eventId,
        envelope.payload
      );

      if (idempCheck.isDuplicate) {
        if (idempCheck.hasConflict) {
          const conflictError: PulseEventEnvelope = {
            eventId: generateUUIDv7(),
            type: 'SYS_ERROR',
            timestamp: Date.now(),
            senderId: 'system',
            correlationId: envelope.correlationId || envelope.eventId,
            payload: {
              code: 'EVENT_ID_CONFLICT',
              message: `Event ID '${envelope.eventId}' has already been processed with a different payload`
            }
          };
          sender.send(conflictError);
          return;
        }

        // Legitimate duplicate: replay cached ACK, preserve correlationId, do NOT broadcast/process again
        if (idempCheck.cachedAck) {
          const replayAck: PulseEventEnvelope = {
            ...idempCheck.cachedAck,
            correlationId: envelope.correlationId || idempCheck.cachedAck.correlationId
          };
          sender.send(replayAck);
          return;
        }
      }
    }

    // 3. Only for NEW events perform sequence validation
    if (envelope.seq !== undefined) {
      if (envelope.seq < sender.lastSeenSeq) {
        logger.warn('Out of order sequence number detected', {
          component: 'MessageDispatcher',
          connectionId: sender.connectionId,
          receivedSeq: envelope.seq,
          lastSeenSeq: sender.lastSeenSeq
        });

        const errorEnvelope: PulseEventEnvelope = {
          eventId: generateUUIDv7(),
          type: 'SYS_ERROR',
          timestamp: Date.now(),
          senderId: 'system',
          correlationId: envelope.correlationId || envelope.eventId,
          payload: {
            code: 'INVALID_SEQUENCE_ORDER',
            message: `Sequence number ${envelope.seq} is out of order (expected >= ${sender.lastSeenSeq})`
          }
        };

        sender.send(errorEnvelope);
        return;
      }
    }

    switch (envelope.type) {
      case 'ROOM_JOIN':
        this.handleRoomJoin(sender, envelope);
        break;

      case 'ROOM_BATCH_JOIN':
        this.handleRoomBatchJoin(sender, envelope);
        break;

      case 'ROOM_LEAVE':
        this.handleRoomLeave(sender, envelope);
        break;

      case 'ROOM_MESSAGE':
        this.handleRoomMessage(sender, envelope);
        break;

      case 'DIRECT_MESSAGE':
        this.handleDirectMessage(sender, envelope);
        break;

      case 'SYS_PING':
        this.handlePing(sender, envelope);
        break;

      case 'SYS_PONG':
        this.handlePong(sender, envelope);
        break;

      default:
        logger.warn('Unhandled event type received', {
          component: 'MessageDispatcher',
          type: envelope.type
        });
        break;
    }
  }

  private handleRoomJoin(
    sender: Connection,
    envelope: PulseEventEnvelope
  ): void {
    const roomId = envelope.target!.roomId!;
    this.roomManager.joinRoom(roomId, sender.connectionId);
    sender.joinRoom(roomId);

    if (envelope.seq !== undefined) {
      sender.lastSeenSeq = envelope.seq;
    }

    const ack: PulseEventEnvelope = {
      eventId: generateUUIDv7(),
      type: 'ROOM_JOIN_ACK',
      timestamp: Date.now(),
      senderId: 'system',
      correlationId: envelope.correlationId || envelope.eventId,
      target: { roomId },
      payload: {
        roomId,
        status: 'JOINED',
        memberCount: this.roomManager.getConnectionCountInRoom(roomId)
      }
    };

    sender.send(ack);
  }

  private handleRoomBatchJoin(
    sender: Connection,
    envelope: PulseEventEnvelope
  ): void {
    const rooms = (envelope.payload as { rooms: string[] }).rooms;
    const joinedRooms: string[] = [];

    for (const roomId of rooms) {
      const trimmed = roomId.trim();
      if (trimmed) {
        this.roomManager.joinRoom(trimmed, sender.connectionId);
        sender.joinRoom(trimmed);
        joinedRooms.push(trimmed);
      }
    }

    if (envelope.seq !== undefined) {
      sender.lastSeenSeq = envelope.seq;
    }

    const ack: PulseEventEnvelope = {
      eventId: generateUUIDv7(),
      type: 'ROOM_BATCH_JOIN_ACK',
      timestamp: Date.now(),
      senderId: 'system',
      correlationId: envelope.correlationId || envelope.eventId,
      payload: {
        joinedRooms,
        totalJoined: joinedRooms.length
      }
    };

    sender.send(ack);
  }

  private handleRoomLeave(
    sender: Connection,
    envelope: PulseEventEnvelope
  ): void {
    const roomId = envelope.target!.roomId!;
    this.roomManager.leaveRoom(roomId, sender.connectionId);
    sender.leaveRoom(roomId);

    if (envelope.seq !== undefined) {
      sender.lastSeenSeq = envelope.seq;
    }

    const ack: PulseEventEnvelope = {
      eventId: generateUUIDv7(),
      type: 'ROOM_LEAVE_ACK',
      timestamp: Date.now(),
      senderId: 'system',
      correlationId: envelope.correlationId || envelope.eventId,
      target: { roomId },
      payload: {
        roomId,
        status: 'LEFT'
      }
    };

    sender.send(ack);
  }

  private handleRoomMessage(
    sender: Connection,
    envelope: PulseEventEnvelope
  ): void {
    const roomId = envelope.target!.roomId!;

    // 1. Enforce room membership authorization
    if (!sender.hasRoom(roomId)) {
      const errorAck: PulseEventEnvelope = {
        eventId: generateUUIDv7(),
        type: 'SYS_ERROR',
        timestamp: Date.now(),
        senderId: 'system',
        correlationId: envelope.correlationId || envelope.eventId,
        target: { roomId },
        payload: {
          code: 'UNAUTHORIZED_ROOM_ACCESS',
          message: `Cannot send message: Connection is not a member of room '${roomId}'`
        }
      };
      sender.send(errorAck);
      return;
    }

    // Update sequence number only after the new event is accepted
    if (envelope.seq !== undefined) {
      sender.lastSeenSeq = envelope.seq;
    }

    // 2. Broadcast to all other room members (excluding sender)
    const memberConnectionIds = this.roomManager.getRoomConnectionIds(roomId);
    let deliveredCount = 0;

    for (const connId of memberConnectionIds) {
      if (connId !== sender.connectionId) {
        const recipient = this.connectionManager.getConnection(connId);
        if (recipient && recipient.send(envelope)) {
          deliveredCount++;
        }
      }
    }

    // 4. Create ACK and record in idempotency cache
    const ack: PulseEventEnvelope = {
      eventId: generateUUIDv7(),
      type: 'DELIVERY_ACK',
      timestamp: Date.now(),
      senderId: 'system',
      correlationId: envelope.correlationId || envelope.eventId,
      target: { roomId },
      payload: {
        targetEventId: envelope.eventId,
        status: 'ACCEPTED',
        recipientCount: deliveredCount
      }
    };

    this.idempotencyManager.recordAck(
      envelope.eventId,
      ack,
      envelope.payload
    );

    sender.send(ack);

    // 5. Publish to Redis for remote instances (if connected)
    if (this.redisPubSubManager && this.redisPubSubManager.isConnected()) {
      const distributedEnvelope = EventValidator.stampForDistribution(envelope, this.instanceId);
      this.redisPubSubManager
        .publish(`pulse:room:${roomId}`, distributedEnvelope)
        .catch((err) => {
          logger.warn('Failed to publish room message to Redis', {
            component: 'MessageDispatcher',
            roomId,
            eventId: envelope.eventId,
            error: err instanceof Error ? err.message : String(err)
          });
        });
    }
  }

  private handleDirectMessage(
    sender: Connection,
    envelope: PulseEventEnvelope
  ): void {
    const recipientId = envelope.target!.recipientId!;

    // Update sequence number only after the new event is accepted
    if (envelope.seq !== undefined) {
      sender.lastSeenSeq = envelope.seq;
    }

    // Deliver to all recipient active sockets
    const recipientConnections =
      this.connectionManager.getConnectionsByUserId(recipientId);

    let deliveredCount = 0;
    for (const conn of recipientConnections) {
      if (conn.send(envelope)) {
        deliveredCount++;
      }
    }

    // 3. Create ACK and record in idempotency cache
    const ack: PulseEventEnvelope = {
      eventId: generateUUIDv7(),
      type: 'DELIVERY_ACK',
      timestamp: Date.now(),
      senderId: 'system',
      correlationId: envelope.correlationId || envelope.eventId,
      target: { recipientId },
      payload: {
        targetEventId: envelope.eventId,
        status: 'ACCEPTED',
        delivered: deliveredCount > 0,
        recipientConnectionCount: deliveredCount
      }
    };

    this.idempotencyManager.recordAck(
      envelope.eventId,
      ack,
      envelope.payload
    );

    sender.send(ack);

    // 4. Publish to Redis for remote instances (if connected)
    if (this.redisPubSubManager && this.redisPubSubManager.isConnected()) {
      const distributedEnvelope = EventValidator.stampForDistribution(envelope, this.instanceId);
      this.redisPubSubManager
        .publish(`pulse:user:${recipientId}`, distributedEnvelope)
        .catch((err) => {
          logger.warn('Failed to publish direct message to Redis', {
            component: 'MessageDispatcher',
            recipientId,
            eventId: envelope.eventId,
            error: err instanceof Error ? err.message : String(err)
          });
        });
    }
  }

  private handlePing(
    sender: Connection,
    envelope: PulseEventEnvelope
  ): void {
    if (envelope.seq !== undefined) {
      sender.lastSeenSeq = envelope.seq;
    }

    const pong: PulseEventEnvelope = {
      eventId: generateUUIDv7(),
      type: 'SYS_PONG',
      timestamp: Date.now(),
      senderId: 'system',
      correlationId: envelope.correlationId || envelope.eventId,
      payload: {
        instanceId: this.instanceId,
        receivedAt: Date.now()
      }
    };
    sender.send(pong);
  }

  private handlePong(
    sender: Connection,
    envelope: PulseEventEnvelope
  ): void {
    if (envelope.seq !== undefined) {
      sender.lastSeenSeq = envelope.seq;
    }
    sender.touch();
  }
}
