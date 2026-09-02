import { IdempotencyManager } from '../../src/core/IdempotencyManager';
import { PulseEventEnvelope } from '../../src/types';

describe('IdempotencyManager (Phase 2)', () => {
  let manager: IdempotencyManager;

  const mockAck: PulseEventEnvelope = {
    eventId: 'ack-001',
    type: 'DELIVERY_ACK',
    timestamp: Date.now(),
    senderId: 'system',
    payload: { status: 'ACCEPTED' }
  };

  beforeEach(() => {
    manager = new IdempotencyManager({ capacity: 3, ttlMs: 100 });
  });

  it('identifies first submission as non-duplicate', () => {
    const res = manager.check('evt-1', { text: 'Hello' });
    expect(res.isDuplicate).toBe(false);
    expect(res.cachedAck).toBeUndefined();
  });

  it('identifies duplicate submission and returns cached ACK', () => {
    manager.recordAck('evt-1', mockAck, { text: 'Hello' });

    const res = manager.check('evt-1', { text: 'Hello' });
    expect(res.isDuplicate).toBe(true);
    expect(res.hasConflict).toBe(false);
    expect(res.cachedAck).toEqual(mockAck);
  });

  it('detects conflicting payload reusing same eventId', () => {
    manager.recordAck('evt-1', mockAck, { text: 'Hello' });

    const res = manager.check('evt-1', { text: 'Conflicting text' });
    expect(res.isDuplicate).toBe(true);
    expect(res.hasConflict).toBe(true);
  });

  it('evicts oldest entry when capacity is exceeded (LRU behavior)', () => {
    manager.recordAck('evt-1', mockAck, { text: 'Msg 1' });
    manager.recordAck('evt-2', mockAck, { text: 'Msg 2' });
    manager.recordAck('evt-3', mockAck, { text: 'Msg 3' });
    expect(manager.size()).toBe(3);

    // Adding 4th entry should evict oldest (evt-1)
    manager.recordAck('evt-4', mockAck, { text: 'Msg 4' });
    expect(manager.size()).toBe(3);

    expect(manager.check('evt-1', { text: 'Msg 1' }).isDuplicate).toBe(false);
    expect(manager.check('evt-2', { text: 'Msg 2' }).isDuplicate).toBe(true);
    expect(manager.check('evt-3', { text: 'Msg 3' }).isDuplicate).toBe(true);
    expect(manager.check('evt-4', { text: 'Msg 4' }).isDuplicate).toBe(true);
  });

  it('updates LRU order when an entry is accessed', () => {
    manager.recordAck('evt-1', mockAck, { text: 'Msg 1' });
    manager.recordAck('evt-2', mockAck, { text: 'Msg 2' });
    manager.recordAck('evt-3', mockAck, { text: 'Msg 3' });

    // Access evt-1 (moves it to most recent position)
    manager.check('evt-1', { text: 'Msg 1' });

    // Adding evt-4 should evict evt-2 (now oldest), NOT evt-1
    manager.recordAck('evt-4', mockAck, { text: 'Msg 4' });

    expect(manager.check('evt-2', { text: 'Msg 2' }).isDuplicate).toBe(false);
    expect(manager.check('evt-1', { text: 'Msg 1' }).isDuplicate).toBe(true);
  });

  it('prunes expired entries based on TTL', async () => {
    manager.recordAck('evt-exp', mockAck, { text: 'Expiring' });
    expect(manager.check('evt-exp', { text: 'Expiring' }).isDuplicate).toBe(true);

    // Wait for TTL (100ms) to pass
    await new Promise((r) => setTimeout(r, 120));

    // Checking directly should treat it as expired
    const checkRes = manager.check('evt-exp', { text: 'Expiring' });
    expect(checkRes.isDuplicate).toBe(false);

    // Prune sweep should be clean
    expect(manager.size()).toBe(0);
  });
});
