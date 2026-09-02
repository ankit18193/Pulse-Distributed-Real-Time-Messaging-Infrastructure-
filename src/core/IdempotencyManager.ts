import crypto from 'crypto';
import { PulseEventEnvelope } from '../types/index.js';
import { logger } from '../utils/logger.js';

export interface IdempotencyEntry {
  readonly eventId: string;
  readonly payloadHash: string;
  readonly ackEnvelope: PulseEventEnvelope;
  readonly timestamp: number;
}

export interface IdempotencyCheckResult {
  isDuplicate: boolean;
  hasConflict?: boolean;
  cachedAck?: PulseEventEnvelope;
}

export class IdempotencyManager {
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly cache: Map<string, IdempotencyEntry> = new Map();

  constructor(options: { capacity?: number; ttlMs?: number } = {}) {
    this.capacity = options.capacity ?? 10000;
    this.ttlMs = options.ttlMs ?? 60000;
  }

  public getCapacity(): number {
    return this.capacity;
  }

  public getTtlMs(): number {
    return this.ttlMs;
  }

  public size(): number {
    return this.cache.size;
  }

  /**
   * Deterministically hashes a payload object to detect conflicting payloads.
   */
  public static hashPayload(payload: unknown): string {
    try {
      const serialized =
        typeof payload === 'object' && payload !== null
          ? JSON.stringify(payload, Object.keys(payload).sort())
          : String(payload);
      return crypto.createHash('sha256').update(serialized).digest('hex');
    } catch {
      return '';
    }
  }

  /**
   * Checks whether an incoming eventId has been previously processed.
   * Maintains LRU ordering if an unexpired entry is matched.
   */
  public check(
    eventId: string,
    currentPayload: unknown
  ): IdempotencyCheckResult {
    const entry = this.cache.get(eventId);
    if (!entry) {
      return { isDuplicate: false };
    }

    const now = Date.now();
    // Check TTL expiry
    if (now - entry.timestamp > this.ttlMs) {
      this.cache.delete(eventId);
      return { isDuplicate: false };
    }

    // Refresh LRU position (delete & set puts key at the end of iteration order)
    this.cache.delete(eventId);
    this.cache.set(eventId, entry);

    // Detect conflicting payloads sharing the same eventId
    const currentHash = IdempotencyManager.hashPayload(currentPayload);
    if (entry.payloadHash !== currentHash) {
      logger.warn('Event ID reused with conflicting payload detected', {
        component: 'IdempotencyManager',
        event: 'EVENT_ID_CONFLICT',
        eventId
      });
      return {
        isDuplicate: true,
        hasConflict: true
      };
    }

    logger.debug('Duplicate event intercepted; returning cached ACK', {
      component: 'IdempotencyManager',
      event: 'DUPLICATE_INTERCEPTED',
      eventId
    });

    return {
      isDuplicate: true,
      hasConflict: false,
      cachedAck: entry.ackEnvelope
    };
  }

  /**
   * Records a successfully executed event and its resulting ACK in the LRU cache.
   */
  public recordAck(
    eventId: string,
    ackEnvelope: PulseEventEnvelope,
    payload: unknown
  ): void {
    // If capacity reached, evict oldest (first key in Map)
    if (this.cache.size >= this.capacity) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    const payloadHash = IdempotencyManager.hashPayload(payload);
    this.cache.set(eventId, {
      eventId,
      payloadHash,
      ackEnvelope,
      timestamp: Date.now()
    });
  }

  /**
   * Sweeps and evicts entries older than the configured TTL.
   */
  public pruneExpired(): number {
    const now = Date.now();
    let pruned = 0;

    for (const [eventId, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttlMs) {
        this.cache.delete(eventId);
        pruned++;
      } else {
        // Since Map retains insertion order, we can break early once an unexpired entry is seen
        break;
      }
    }

    return pruned;
  }

  public clear(): void {
    this.cache.clear();
  }
}
