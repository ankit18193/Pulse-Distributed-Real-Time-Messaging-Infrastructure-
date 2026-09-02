import crypto from 'crypto';
import { Connection } from './Connection.js';
import { ConnectionManager } from './ConnectionManager.js';
import { RoomManager } from './RoomManager.js';
import { EventValidator } from '../events/EventValidator.js';
import { PulseEventEnvelope } from '../types/index.js';
import { logger } from '../utils/logger.js';

export class MessageDispatcher {
  private readonly connectionManager: ConnectionManager;
  private readonly roomManager: RoomManager;
  private readonly instanceId: string;

  constructor(options: {
    connectionManager: ConnectionManager;
    roomManager: RoomManager;
    instanceId: string;
  }) {
    this.connectionManager = options.connectionManager;
    this.roomManager = options.roomManager;
    this.instanceId = options.instanceId;
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
        eventId: crypto.randomUUID(),
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

    switch (envelope.type) {
      case 'ROOM_JOIN':
        this.handleRoomJoin(sender, envelope);
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

    const ack: PulseEventEnvelope = {
      eventId: crypto.randomUUID(),
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

  private handleRoomLeave(
    sender: Connection,
    envelope: PulseEventEnvelope
  ): void {
    const roomId = envelope.target!.roomId!;
    this.roomManager.leaveRoom(roomId, sender.connectionId);
    sender.leaveRoom(roomId);

    const ack: PulseEventEnvelope = {
      eventId: crypto.randomUUID(),
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

    // Enforce room membership authorization
    if (!sender.hasRoom(roomId)) {
      const errorAck: PulseEventEnvelope = {
        eventId: crypto.randomUUID(),
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

    const memberConnectionIds = this.roomManager.getRoomConnectionIds(roomId);
    let deliveredCount = 0;

    for (const connId of memberConnectionIds) {
      // Broadcast to other members, do not echo back to the sender
      if (connId !== sender.connectionId) {
        const recipient = this.connectionManager.getConnection(connId);
        if (recipient && recipient.send(envelope)) {
          deliveredCount++;
        }
      }
    }

    // Always send an acknowledgement back to the sender
    const ack: PulseEventEnvelope = {
      eventId: crypto.randomUUID(),
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

    sender.send(ack);
  }

  private handleDirectMessage(
    sender: Connection,
    envelope: PulseEventEnvelope
  ): void {
    const recipientId = envelope.target!.recipientId!;
    const recipientConnections =
      this.connectionManager.getConnectionsByUserId(recipientId);

    let deliveredCount = 0;
    for (const conn of recipientConnections) {
      if (conn.send(envelope)) {
        deliveredCount++;
      }
    }

    const ack: PulseEventEnvelope = {
      eventId: crypto.randomUUID(),
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

    sender.send(ack);
  }

  private handlePing(
    sender: Connection,
    envelope: PulseEventEnvelope
  ): void {
    const pong: PulseEventEnvelope = {
      eventId: crypto.randomUUID(),
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
    _envelope: PulseEventEnvelope
  ): void {
    sender.touch();
  }
}
