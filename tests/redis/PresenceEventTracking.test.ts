import RedisMock from 'ioredis-mock';
import { PresenceEventTracker } from '../../src/redis/PresenceEventTracker.js';
import { PresenceManager } from '../../src/redis/PresenceManager.js';

describe('PresenceEventTracker & Stale Event Protection', () => {
  let tracker: PresenceEventTracker;

  beforeEach(() => {
    tracker = new PresenceEventTracker({ maxUsers: 10000 });
  });

  it('initializes with expected capacity and empty size', () => {
    expect(tracker.getMaxUsers()).toBe(10000);
    expect(tracker.size()).toBe(0);
  });

  it('accepts initial event and rejects stale or equal subsequent timestamps', () => {
    const userId = 'user-alice';
    const t1 = 1000;

    // First event accepted
    expect(tracker.isStale(userId, t1)).toBe(false);
    const recorded1 = tracker.recordEvent(userId, t1);
    expect(recorded1).toBe(true);
    expect(tracker.getLastSeenTimestamp(userId)).toBe(t1);

    // Stale event (older timestamp) rejected
    const tOld = 900;
    expect(tracker.isStale(userId, tOld)).toBe(true);
    expect(tracker.recordEvent(userId, tOld)).toBe(false);
    expect(tracker.getLastSeenTimestamp(userId)).toBe(t1);

    // Equal timestamp rejected (stale/equal rejection requirement)
    expect(tracker.isStale(userId, t1)).toBe(true);
    expect(tracker.recordEvent(userId, t1)).toBe(false);
    expect(tracker.getLastSeenTimestamp(userId)).toBe(t1);

    // Strictly newer timestamp accepted
    const t2 = 1001;
    expect(tracker.isStale(userId, t2)).toBe(false);
    expect(tracker.recordEvent(userId, t2)).toBe(true);
    expect(tracker.getLastSeenTimestamp(userId)).toBe(t2);
  });

  it('tracks monotonic progression across multiple events for the same user', () => {
    const userId = 'user-bob';
    const timestamps = [100, 200, 150, 250, 250, 300, 299];
    const results: boolean[] = [];

    for (const ts of timestamps) {
      results.push(tracker.recordEvent(userId, ts));
    }

    // 100: accepted (true)
    // 200: accepted (true)
    // 150: rejected (false, 150 <= 200)
    // 250: accepted (true)
    // 250: rejected (false, equal)
    // 300: accepted (true)
    // 299: rejected (false, 299 <= 300)
    expect(results).toEqual([true, true, false, true, false, true, false]);
    expect(tracker.getLastSeenTimestamp(userId)).toBe(300);
  });

  it('isolates timestamps between different users', () => {
    tracker.recordEvent('user-1', 500);
    tracker.recordEvent('user-2', 100);

    // user-2 can record 200 even though user-1 is at 500
    expect(tracker.recordEvent('user-2', 200)).toBe(true);
    expect(tracker.getLastSeenTimestamp('user-2')).toBe(200);

    // user-1 cannot record 400
    expect(tracker.recordEvent('user-1', 400)).toBe(false);
    expect(tracker.getLastSeenTimestamp('user-1')).toBe(500);
  });

  it('bounds memory by evicting oldest user when maxUsers capacity is reached', () => {
    const boundedTracker = new PresenceEventTracker({ maxUsers: 3 });

    boundedTracker.recordEvent('user-A', 100);
    boundedTracker.recordEvent('user-B', 200);
    boundedTracker.recordEvent('user-C', 300);

    expect(boundedTracker.size()).toBe(3);

    // Adding user-D should evict user-A (oldest entry)
    boundedTracker.recordEvent('user-D', 400);
    expect(boundedTracker.size()).toBe(3);
    expect(boundedTracker.getLastSeenTimestamp('user-A')).toBeUndefined();
    expect(boundedTracker.getLastSeenTimestamp('user-B')).toBe(200);
    expect(boundedTracker.getLastSeenTimestamp('user-C')).toBe(300);
    expect(boundedTracker.getLastSeenTimestamp('user-D')).toBe(400);
  });

  it('refreshes LRU position when an existing user updates, preserving it across evictions', () => {
    const boundedTracker = new PresenceEventTracker({ maxUsers: 3 });

    boundedTracker.recordEvent('user-A', 100);
    boundedTracker.recordEvent('user-B', 200);
    boundedTracker.recordEvent('user-C', 300);

    // Update user-A with newer timestamp; moves user-A to MRU position
    boundedTracker.recordEvent('user-A', 350);

    // Adding user-D should now evict user-B (which is now the oldest)
    boundedTracker.recordEvent('user-D', 400);
    expect(boundedTracker.size()).toBe(3);
    expect(boundedTracker.getLastSeenTimestamp('user-A')).toBe(350);
    expect(boundedTracker.getLastSeenTimestamp('user-B')).toBeUndefined();
    expect(boundedTracker.getLastSeenTimestamp('user-C')).toBe(300);
    expect(boundedTracker.getLastSeenTimestamp('user-D')).toBe(400);
  });

  it('handles invalid user or timestamp inputs gracefully', () => {
    expect(tracker.isStale('', 100)).toBe(true);
    expect(tracker.recordEvent('', 100)).toBe(false);
    expect(tracker.recordEvent('user-1', NaN)).toBe(false);
    expect(tracker.recordEvent('user-1', undefined as unknown as number)).toBe(false);
  });

  it('clears all tracked timestamps on clear()', () => {
    tracker.recordEvent('user-1', 100);
    tracker.recordEvent('user-2', 200);
    expect(tracker.size()).toBe(2);

    tracker.clear();
    expect(tracker.size()).toBe(0);
    expect(tracker.getLastSeenTimestamp('user-1')).toBeUndefined();
  });

  it('integrates seamlessly via PresenceManager', () => {
    const redisMock = new (RedisMock as any)();
    const presenceManager = new PresenceManager(redisMock, 'node-1', { maxTrackedUsers: 2 });

    expect(presenceManager.isStalePresenceEvent('user-X', 1000)).toBe(false);
    expect(presenceManager.recordPresenceEvent('user-X', 1000)).toBe(true);

    // Stale check
    expect(presenceManager.isStalePresenceEvent('user-X', 999)).toBe(true);
    expect(presenceManager.recordPresenceEvent('user-X', 999)).toBe(false);

    // Equal check
    expect(presenceManager.isStalePresenceEvent('user-X', 1000)).toBe(true);
    expect(presenceManager.recordPresenceEvent('user-X', 1000)).toBe(false);

    // Newer check
    expect(presenceManager.isStalePresenceEvent('user-X', 1001)).toBe(false);
    expect(presenceManager.recordPresenceEvent('user-X', 1001)).toBe(true);
  });
});
