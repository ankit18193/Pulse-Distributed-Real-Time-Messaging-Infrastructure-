import { Connection } from './Connection.js';
import { ConnectionManager } from './ConnectionManager.js';
import { RoomManager } from './RoomManager.js';
import { IdempotencyManager } from './IdempotencyManager.js';
import { EventValidator } from '../events/EventValidator.js';
import { PulseEventEnvelope } from '../types/index.js';
import { generateUUIDv7 } from '../utils/uuidv7.js';
import { logger } from '../utils/logger.js';

export class MessageDispatcher {
  private readonly connectionManager: ConnectionManager;
  private readonly roomManager: RoomManager;
  private readonly idempotencyManager: IdempotencyManager;
  private readonly instanceId: string;

  constructor(options: {
    connectionManager: ConnectionManager;
    roomManager: RoomManager;
    idempotencyManager?: IdempotencyManager;
    instanceId: string;
  }) {
    this.connectionManager = options.connectionManager;
    this.roomManager = options.roomManager;
    this.idempotencyManager =
      options.idempotencyManager ?? new IdempotencyManager();
    this.instanceId = options.instanceId;
  }

  public getIdempotencyManager(): IdempotencyManager {
    return this.idempotencyManager;
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
