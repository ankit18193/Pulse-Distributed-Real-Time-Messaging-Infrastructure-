/**
 * Pulse Distributed Real-Time Messaging Infrastructure
 * Bounded Presence Event Tracker
 *
 * Enforces monotonic timestamp ordering per user to prevent out-of-order,
 * stale, or replay presence updates from overwriting newer state.
 * Uses bounded LRU eviction (maximum 10,000 users by default) to guarantee
 * deterministic memory consumption.
 */

export interface PresenceEventTrackerOptions {
  maxUsers?: number;
}

export class PresenceEventTracker {
  private readonly maxUsers: number;
  private readonly lastSeenTimestamps: Map<string, number> = new Map();

  constructor(options: PresenceEventTrackerOptions = {}) {
    this.maxUsers = options.maxUsers ?? 10000;
  }

  public getMaxUsers(): number {
    return this.maxUsers;
  }

  public size(): number {
    return this.lastSeenTimestamps.size;
  }

  public getLastSeenTimestamp(userId: string): number | undefined {
    return this.lastSeenTimestamps.get(userId);
  }

  /**
   * Checks whether an incoming presence event timestamp is stale or equal to
   * the last-seen timestamp for the given user.
   *
   * Rejects if incomingTimestamp <= lastSeenTimestamp.
   */
  public isStale(userId: string, timestamp: number): boolean {
    if (!userId || typeof timestamp !== 'number' || isNaN(timestamp)) {
      return true;
    }
    const lastSeen = this.lastSeenTimestamps.get(userId);
    if (lastSeen !== undefined && timestamp <= lastSeen) {
      return true;
    }
    return false;
  }

  /**
   * Records a presence event timestamp for a user if strictly greater than last-seen.
   * Refreshes LRU positioning on update.
   * Evicts the oldest entry when capacity is exceeded.
   *
   * @returns true if accepted and recorded, false if rejected (stale or equal).
   */
  public recordEvent(userId: string, timestamp: number): boolean {
    if (!userId || typeof timestamp !== 'number' || isNaN(timestamp)) {
      return false;
    }

    const lastSeen = this.lastSeenTimestamps.get(userId);
    if (lastSeen !== undefined && timestamp <= lastSeen) {
      return false;
    }

    // Refresh LRU position (delete & set puts key at the end of Map iteration)
    if (this.lastSeenTimestamps.has(userId)) {
      this.lastSeenTimestamps.delete(userId);
    } else if (this.lastSeenTimestamps.size >= this.maxUsers) {
      // Evict oldest user (first key in Map)
      const oldestKey = this.lastSeenTimestamps.keys().next().value;
      if (oldestKey !== undefined) {
        this.lastSeenTimestamps.delete(oldestKey);
      }
    }

    this.lastSeenTimestamps.set(userId, timestamp);
    return true;
  }

  public clear(): void {
    this.lastSeenTimestamps.clear();
  }
}
