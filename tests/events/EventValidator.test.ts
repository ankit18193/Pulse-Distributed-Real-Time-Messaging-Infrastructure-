import { EventValidator } from '../../src/events/EventValidator';

describe('EventValidator (Commit 3)', () => {
  const senderId = 'user_alice';

  it('validates a correct ROOM_JOIN event envelope', () => {
    const raw = JSON.stringify({
      type: 'ROOM_JOIN',
      target: { roomId: 'engineering' }
    });

    const res = EventValidator.validateIncoming(raw, senderId);
    expect(res.valid).toBe(true);
    expect(res.envelope).toBeDefined();
    expect(res.envelope?.type).toBe('ROOM_JOIN');
    expect(res.envelope?.senderId).toBe('user_alice');
    expect(res.envelope?.target?.roomId).toBe('engineering');
    expect(typeof res.envelope?.eventId).toBe('string');
    expect(typeof res.envelope?.timestamp).toBe('number');
  });

  it('validates a correct ROOM_MESSAGE event envelope', () => {
    const raw = JSON.stringify({
      eventId: 'evt_12345',
      type: 'ROOM_MESSAGE',
      target: { roomId: 'general' },
      payload: { content: 'Hello World' },
      ackRequired: true
    });

    const res = EventValidator.validateIncoming(raw, senderId);
    expect(res.valid).toBe(true);
    expect(res.envelope?.eventId).toBe('evt_12345');
    expect(res.envelope?.type).toBe('ROOM_MESSAGE');
    expect(res.envelope?.payload).toEqual({ content: 'Hello World' });
    expect(res.envelope?.ackRequired).toBe(true);
  });

  it('validates a correct DIRECT_MESSAGE event envelope', () => {
    const raw = JSON.stringify({
      type: 'DIRECT_MESSAGE',
      target: { recipientId: 'user_bob' },
      payload: { text: 'Private note' }
    });

    const res = EventValidator.validateIncoming(raw, senderId);
    expect(res.valid).toBe(true);
    expect(res.envelope?.target?.recipientId).toBe('user_bob');
  });

  it('rejects malformed JSON', () => {
    const res = EventValidator.validateIncoming('{ invalid json', senderId);
    expect(res.valid).toBe(false);
    expect(res.error?.code).toBe('MALFORMED_JSON');
  });

  it('rejects non-object payloads', () => {
    const res = EventValidator.validateIncoming('"plain string"', senderId);
    expect(res.valid).toBe(false);
    expect(res.error?.code).toBe('INVALID_ENVELOPE');
  });

  it('rejects unrecognized event types', () => {
    const raw = JSON.stringify({ type: 'UNKNOWN_CUSTOM_TYPE' });
    const res = EventValidator.validateIncoming(raw, senderId);
    expect(res.valid).toBe(false);
    expect(res.error?.code).toBe('UNRECOGNIZED_EVENT_TYPE');
  });

  it('rejects ROOM_JOIN / ROOM_MESSAGE missing roomId', () => {
    const raw = JSON.stringify({ type: 'ROOM_JOIN' });
    const res = EventValidator.validateIncoming(raw, senderId);
    expect(res.valid).toBe(false);
    expect(res.error?.code).toBe('MISSING_ROOM_ID');
  });

  it('rejects DIRECT_MESSAGE missing recipientId', () => {
    const raw = JSON.stringify({ type: 'DIRECT_MESSAGE' });
    const res = EventValidator.validateIncoming(raw, senderId);
    expect(res.valid).toBe(false);
    expect(res.error?.code).toBe('MISSING_RECIPIENT_ID');
  });
});
