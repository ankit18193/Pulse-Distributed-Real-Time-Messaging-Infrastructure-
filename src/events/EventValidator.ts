import { EventType, PulseEventEnvelope } from '../types/index.js';
import { generateUUIDv7 } from '../utils/uuidv7.js';

export interface ValidationResult<T = unknown> {
  valid: boolean;
  envelope?: PulseEventEnvelope<T>;
  error?: {
    code: string;
    message: string;
    correlationId?: string;
  };
}

export const VALID_EVENT_TYPES: Set<EventType> = new Set([
  'SYS_CONNECT_ACK',
  'SYS_PING',
  'SYS_PONG',
  'SYS_ERROR',
  'SYS_SHUTDOWN',
  'ROOM_JOIN',
  'ROOM_JOIN_ACK',
  'ROOM_LEAVE',
  'ROOM_LEAVE_ACK',
  'ROOM_BATCH_JOIN',
  'ROOM_BATCH_JOIN_ACK',
  'ROOM_MESSAGE',
  'DIRECT_MESSAGE',
  'DELIVERY_ACK'
]);

export const MAX_BATCH_ROOMS = 50;

export class EventValidator {
  /**
   * Safely parses and validates an incoming raw WebSocket frame.
   */
  public static validateIncoming(
    raw: string | Buffer,
    senderId: string
  ): ValidationResult {
    let parsed: unknown;

    try {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      parsed = JSON.parse(text);
    } catch {
      return {
        valid: false,
        error: {
          code: 'MALFORMED_JSON',
          message: 'Incoming frame is not valid JSON'
        }
      };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        valid: false,
        error: {
          code: 'INVALID_ENVELOPE',
          message: 'Incoming event must be a JSON object'
        }
      };
    }

    const obj = parsed as Record<string, unknown>;
    const correlationId =
      typeof obj.correlationId === 'string' ? obj.correlationId : undefined;

    // Check type
    if (!obj.type || typeof obj.type !== 'string') {
      return {
        valid: false,
        error: {
          code: 'MISSING_EVENT_TYPE',
          message: 'Event must specify a valid string type',
          correlationId
        }
      };
    }

    const eventType = obj.type as EventType;
    if (!VALID_EVENT_TYPES.has(eventType)) {
      return {
        valid: false,
        error: {
          code: 'UNRECOGNIZED_EVENT_TYPE',
          message: `Event type '${eventType}' is not supported`,
          correlationId
        }
      };
    }

    // Ensure eventId exists or generate a valid monotonic UUIDv7
    const eventId =
      typeof obj.eventId === 'string' && obj.eventId.length > 0
        ? obj.eventId
        : generateUUIDv7();

    // Ensure timestamp exists or assign current time
    const timestamp =
      typeof obj.timestamp === 'number' && obj.timestamp > 0
        ? obj.timestamp
        : Date.now();

    // Validate optional sequence number
    let seq: number | undefined;
    if (obj.seq !== undefined) {
      if (typeof obj.seq !== 'number' || !Number.isInteger(obj.seq) || obj.seq < 1) {
        return {
          valid: false,
          error: {
            code: 'INVALID_SEQUENCE_NUMBER',
            message: 'Sequence number seq must be a positive integer',
            correlationId
          }
        };
      }
      seq = obj.seq;
    }

    // Validate payload
    const payload =
      obj.payload && typeof obj.payload === 'object' && !Array.isArray(obj.payload)
        ? (obj.payload as Record<string, unknown>)
        : {};

    // Validate target
    let target: { roomId?: string; recipientId?: string } | undefined;
    if (obj.target && typeof obj.target === 'object' && !Array.isArray(obj.target)) {
      const t = obj.target as Record<string, unknown>;
      target = {
        roomId: typeof t.roomId === 'string' ? t.roomId.trim() : undefined,
        recipientId:
          typeof t.recipientId === 'string' ? t.recipientId.trim() : undefined
      };
    }

    // Also support roomId / recipientId in payload for developer convenience
    if (!target?.roomId && typeof payload.roomId === 'string') {
      target = { ...target, roomId: payload.roomId.trim() };
    }
    if (!target?.recipientId && typeof payload.recipientId === 'string') {
      target = { ...target, recipientId: payload.recipientId.trim() };
    }

    // Type-specific requirements
    if (eventType === 'ROOM_JOIN' || eventType === 'ROOM_LEAVE') {
      if (!target?.roomId) {
        return {
          valid: false,
          error: {
            code: 'MISSING_ROOM_ID',
            message: `Event '${eventType}' requires a valid non-empty roomId`,
            correlationId
          }
        };
      }
    }

    if (eventType === 'ROOM_BATCH_JOIN') {
      const rooms = payload.rooms;
      if (!Array.isArray(rooms) || rooms.length === 0) {
        return {
          valid: false,
          error: {
            code: 'INVALID_ROOMS_ARRAY',
            message: "Event 'ROOM_BATCH_JOIN' requires a non-empty 'rooms' array in payload",
            correlationId
          }
        };
      }

      if (rooms.length > MAX_BATCH_ROOMS) {
        return {
          valid: false,
          error: {
            code: 'BATCH_SIZE_EXCEEDED',
            message: `Event 'ROOM_BATCH_JOIN' exceeds maximum batch limit of ${MAX_BATCH_ROOMS} rooms`,
            correlationId
          }
        };
      }

      // Check all elements are non-empty strings
      for (const r of rooms) {
        if (typeof r !== 'string' || r.trim().length === 0) {
          return {
            valid: false,
            error: {
              code: 'INVALID_ROOM_ID',
              message: "All entries in 'rooms' array must be non-empty strings",
              correlationId
            }
          };
        }
      }
    }

    if (eventType === 'ROOM_MESSAGE') {
      if (!target?.roomId) {
        return {
          valid: false,
          error: {
            code: 'MISSING_ROOM_ID',
            message: "Event 'ROOM_MESSAGE' requires a valid non-empty roomId",
            correlationId
          }
        };
      }
      if (payload.content === undefined && Object.keys(payload).length === 0) {
        return {
          valid: false,
          error: {
            code: 'EMPTY_PAYLOAD',
            message: "Event 'ROOM_MESSAGE' requires a non-empty payload",
            correlationId
          }
        };
      }
    }

    if (eventType === 'DIRECT_MESSAGE') {
      if (!target?.recipientId) {
        return {
          valid: false,
          error: {
            code: 'MISSING_RECIPIENT_ID',
            message: "Event 'DIRECT_MESSAGE' requires a valid non-empty recipientId",
            correlationId
          }
        };
      }
    }

    const envelope: PulseEventEnvelope = {
      eventId,
      type: eventType,
      timestamp,
      senderId,
      seq,
      target,
      payload,
      correlationId,
      ackRequired: obj.ackRequired === true
    };

    return {
      valid: true,
      envelope
    };
  }
}
