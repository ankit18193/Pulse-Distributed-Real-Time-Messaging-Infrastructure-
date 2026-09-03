import { RedisPubSubManager } from './RedisPubSubManager.js';
import { logger } from '../utils/logger.js';

export const CHANNEL_PREFIX_ROOM = 'pulse:room:';
export const CHANNEL_PREFIX_USER = 'pulse:user:';

export function getRoomChannel(roomId: string): string {
  if (!roomId || typeof roomId !== 'string' || roomId.trim() === '') {
    throw new Error('Invalid roomId provided for channel generation');
  }
  return `${CHANNEL_PREFIX_ROOM}${roomId.trim()}`;
}

export function getUserChannel(userId: string): string {
  if (!userId || typeof userId !== 'string' || userId.trim() === '') {
    throw new Error('Invalid userId provided for channel generation');
  }
  return `${CHANNEL_PREFIX_USER}${userId.trim()}`;
}

export function isRoomChannel(channel: string): boolean {
  return channel.startsWith(CHANNEL_PREFIX_ROOM);
}

export function isUserChannel(channel: string): boolean {
  return channel.startsWith(CHANNEL_PREFIX_USER);
}

export function extractRoomId(channel: string): string | null {
  if (!isRoomChannel(channel)) return null;
  return channel.slice(CHANNEL_PREFIX_ROOM.length);
}

export function extractUserId(channel: string): string | null {
  if (!isUserChannel(channel)) return null;
  return channel.slice(CHANNEL_PREFIX_USER.length);
}

export class ChannelRegistry {
  private readonly pubSubManager: RedisPubSubManager;
  private readonly instanceId: string;
  private readonly channelRefCounts = new Map<string, number>();

  constructor(pubSubManager: RedisPubSubManager, instanceId: string = 'pulse-node-1') {
    this.pubSubManager = pubSubManager;
    this.instanceId = instanceId;
  }

  /**
   * Increment reference count for a room channel.
   * If ref count transitions from 0 -> 1, issues physical Redis SUBSCRIBE.
   * Returns true if physical SUBSCRIBE was issued, false if merely reference-incremented.
   */
  public async subscribeRoom(roomId: string): Promise<boolean> {
    const channel = getRoomChannel(roomId);
    return this.incrementSubscription(channel);
  }

  /**
   * Decrement reference count for a room channel.
   * If ref count transitions from 1 -> 0, issues physical Redis UNSUBSCRIBE.
   * Returns true if physical UNSUBSCRIBE was issued, false if reference-decremented or no-op.
   */
  public async unsubscribeRoom(roomId: string): Promise<boolean> {
    const channel = getRoomChannel(roomId);
    return this.decrementSubscription(channel);
  }

  /**
   * Increment reference count for a user channel.
   * If ref count transitions from 0 -> 1, issues physical Redis SUBSCRIBE.
   */
  public async subscribeUser(userId: string): Promise<boolean> {
    const channel = getUserChannel(userId);
    return this.incrementSubscription(channel);
  }

  /**
   * Decrement reference count for a user channel.
   * If ref count transitions from 1 -> 0, issues physical Redis UNSUBSCRIBE.
   */
  public async unsubscribeUser(userId: string): Promise<boolean> {
    const channel = getUserChannel(userId);
    return this.decrementSubscription(channel);
  }

  /**
   * Returns current reference count for a specific channel.
   */
  public getRefCount(channel: string): number {
    return this.channelRefCounts.get(channel) ?? 0;
  }

  /**
   * Returns all active channels currently tracked with refCount > 0.
   */
  public getActiveChannels(): string[] {
    return Array.from(this.channelRefCounts.keys());
  }

  /**
   * Number of active distinct channels with local subscribers.
   */
  public getActiveChannelCount(): number {
    return this.channelRefCounts.size;
  }

  /**
   * Clear all local reference counts and unsubscribes from Redis.
   */
  public async clear(): Promise<void> {
    const channels = Array.from(this.channelRefCounts.keys());
    this.channelRefCounts.clear();

    for (const channel of channels) {
      try {
        await this.pubSubManager.unsubscribe(channel);
      } catch (err) {
        logger.warn('Error unsubscribing channel during clear', {
          instanceId: this.instanceId,
          channel,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  private async incrementSubscription(channel: string): Promise<boolean> {
    const currentCount = this.channelRefCounts.get(channel) ?? 0;
    const newCount = currentCount + 1;
    this.channelRefCounts.set(channel, newCount);

    if (currentCount === 0) {
      // 0 -> 1: First local subscriber, physically subscribe
      logger.debug('Subscribing to channel (0 -> 1 transition)', {
        instanceId: this.instanceId,
        channel,
        refCount: newCount
      });
      await this.pubSubManager.subscribe(channel);
      return true;
    }

    // 1 -> 2+: Already subscribed, no Redis call needed
    logger.debug('Incremented channel ref count without Redis subscribe', {
      instanceId: this.instanceId,
      channel,
      refCount: newCount
    });
    return false;
  }

  private async decrementSubscription(channel: string): Promise<boolean> {
    const currentCount = this.channelRefCounts.get(channel) ?? 0;

    if (currentCount <= 0) {
      // No-op, prevent negative reference leak
      this.channelRefCounts.delete(channel);
      return false;
    }

    if (currentCount === 1) {
      // 1 -> 0: Last local subscriber leaving, physically unsubscribe
      this.channelRefCounts.delete(channel);
      logger.debug('Unsubscribing from channel (1 -> 0 transition)', {
        instanceId: this.instanceId,
        channel
      });
      await this.pubSubManager.unsubscribe(channel);
      return true;
    }

    // 2 -> 1: Still has remaining subscribers, do not unsubscribe from Redis
    const newCount = currentCount - 1;
    this.channelRefCounts.set(channel, newCount);
    logger.debug('Decremented channel ref count, remaining subscribed', {
      instanceId: this.instanceId,
      channel,
      refCount: newCount
    });
    return false;
  }
}
