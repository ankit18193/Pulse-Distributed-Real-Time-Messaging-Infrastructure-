import { EventValidator } from '../../src/events/EventValidator.js';
import { PulseEventEnvelope } from '../../src/types/index.js';

describe('EventValidator originInstanceId & Distributed Metadata', () => {
  const validRoomMessage = {
    eventId: '018f673a-4421-7299-8d18-7f9999999999',
    type: 'ROOM_MESSAGE',
    timestamp: Date.now(),
    senderId: 'user-1',
    target: { roomId: 'dev-chat' },
    payload: { text: 'Hello distributed' },
    seq: 42
  };

  describe('Local Incoming Frame Validation', () => {
    test('accepts envelope without originInstanceId for purely local events', () => {
      const result = EventValidator.validateIncoming(JSON.stringify(validRoomMessage), 'user-1');
      expect(result.valid).toBe(true);
      expect(result.envelope?.originInstanceId).toBeUndefined();
      expect(result.envelope?.seq).toBe(42);
    });

    test('accepts and includes originInstanceId when provided as valid string', () => {
      const withOrigin = { ...validRoomMessage, originInstanceId: 'pulse-node-1' };
      const result = EventValidator.validateIncoming(JSON.stringify(withOrigin), 'user-1');
      expect(result.valid).toBe(true);
      expect(result.envelope?.originInstanceId).toBe('pulse-node-1');
    });

    test('rejects empty or whitespace-only originInstanceId', () => {
      const emptyOrigin = { ...validRoomMessage, originInstanceId: '   ' };
      const result = EventValidator.validateIncoming(JSON.stringify(emptyOrigin), 'user-1');
      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe('INVALID_ORIGIN_INSTANCE_ID');
    });

    test('rejects non-string originInstanceId', () => {
      const numOrigin = { ...validRoomMessage, originInstanceId: 12345 };
      const result = EventValidator.validateIncoming(JSON.stringify(numOrigin), 'user-1');
      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe('INVALID_ORIGIN_INSTANCE_ID');
    });
  });

  describe('Distributed Envelope Validation & Isolation', () => {
    test('requires originInstanceId on distributed Redis events', () => {
      const withoutOrigin = { ...validRoomMessage };
      const result = EventValidator.validateDistributed(withoutOrigin);
      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe('MISSING_ORIGIN_INSTANCE_ID');
    });

    test('validates distributed envelope and strictly strips connection-local seq', () => {
      const distributedRaw = {
        ...validRoomMessage,
        originInstanceId: 'pulse-node-2',
        seq: 99
      };

      const result = EventValidator.validateDistributed(distributedRaw);
      expect(result.valid).toBe(true);
      expect(result.envelope?.originInstanceId).toBe('pulse-node-2');
      // seq must be stripped to prevent using connection-local seq as distributed ordering
      expect(result.envelope?.seq).toBeUndefined();
    });

    test('stampForDistribution stamps instanceId and strips seq', () => {
      const localEnvelope: PulseEventEnvelope = {
        eventId: '018f673a-4421-7299-8d18-7f9999999999',
        type: 'ROOM_MESSAGE',
        timestamp: 1000000,
        senderId: 'user-1',
        target: { roomId: 'dev-chat' },
        payload: { text: 'test' },
        seq: 5
      };

      const stamped = EventValidator.stampForDistribution(localEnvelope, 'pulse-node-1');
      expect(stamped.originInstanceId).toBe('pulse-node-1');
      expect(stamped.seq).toBeUndefined();
      expect(stamped.eventId).toBe(localEnvelope.eventId);
    });
  });
});
