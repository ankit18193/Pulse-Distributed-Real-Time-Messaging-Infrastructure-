import type { Redis } from 'ioredis';
import {
  executeRegisterPresence,
  executeRemovePresence,
  getPresenceUserKey,
  formatPresenceMember,
  parsePresenceMember,
  DEFAULT_KEY_SAFEGUARD_TTL_SEC
} from './PresenceLuaScripts.js';
import { PresenceEventTracker } from './PresenceEventTracker.js';
import { logger } from '../utils/logger.js';

export interface PresenceManagerOptions {
  presenceTtlMs?: number;
  presenceFlushIntervalMs?: number;
  keySafeguardTtlSec?: number;
  maxTrackedUsers?: number;
}

export interface PresenceRegistrationResult {
  isOnlineTransition: boolean;
  activeConnections: number;
}

export interface PresenceRemovalResult {
  isOfflineTransition: boolean;
  activeConnections: number;
}

export interface ActiveConnectionLease {
  instanceId: string;
  connectionId: string;
}

export class PresenceManager {
  private readonly redisClient: Redis;
  private readonly instanceId: string;
  private readonly presenceTtlMs: number;
  private readonly presenceFlushIntervalMs: number;
  private readonly keySafeguardTtlSec: number;
  private readonly eventTracker: PresenceEventTracker;
  private readonly localConnections: Map<string, { userId: string; connectionId: string }> = new Map();
  private activeConnectionProvider?: () => Array<{ userId: string; connectionId: string }>;
  private renewalTimer?: NodeJS.Timeout;
  private isFlushing: boolean = false;

  constructor(
    redisClient: Redis,
    instanceId: string = 'pulse-node-1',
    options: PresenceManagerOptions = {}
  ) {
    this.redisClient = redisClient;
    this.instanceId = instanceId;
    this.presenceTtlMs = options.presenceTtlMs ?? 60000;
    this.presenceFlushIntervalMs = options.presenceFlushIntervalMs ?? 15000;
    this.keySafeguardTtlSec = options.keySafeguardTtlSec ?? DEFAULT_KEY_SAFEGUARD_TTL_SEC;
    this.eventTracker = new PresenceEventTracker({ maxUsers: options.maxTrackedUsers });
  }

  public getInstanceId(): string {
    return this.instanceId;
  }

  public getPresenceFlushIntervalMs(): number {
    return this.presenceFlushIntervalMs;
  }

  public getEventTracker(): PresenceEventTracker {
    return this.eventTracker;
  }

  public isStalePresenceEvent(userId: string, timestamp: number): boolean {
    return this.eventTracker.isStale(userId, timestamp);
  }

  public recordPresenceEvent(userId: string, timestamp: number): boolean {
    return this.eventTracker.recordEvent(userId, timestamp);
  }

  public getPresenceTtlMs(): number {
    return this.presenceTtlMs;
  }

  /**
   * Registers a connection lease for a user in the distributed Redis ZSET.
   * Atomically prunes expired leases and determines whether this caused a 0 -> 1 transition (ONLINE).
   */
  public async registerConnection(
    userId: string,
    connectionId: string,
    customExpireAtMs?: number,
    customNowMs?: number
  ): Promise<PresenceRegistrationResult> {
    if (!userId || !connectionId) {
      throw new Error('userId and connectionId are required for presence registration');
    }

    const now = customNowMs ?? Date.now();
    const expireAt = customExpireAtMs ?? now + this.presenceTtlMs;

    try {
      const transition = await executeRegisterPresence(
        this.redisClient,
        userId,
        this.instanceId,
        connectionId,
        expireAt,
        now,
        this.keySafeguardTtlSec
      );

      const activeConnections = await this.getUserConnectionCount(userId, now);

      this.localConnections.set(connectionId, { userId, connectionId });

      logger.info('Presence connection registered', {
        component: 'PresenceManager',
        userId,
        connectionId,
        instanceId: this.instanceId,
        isOnlineTransition: transition === 1,
        activeConnections
      });

      return {
        isOnlineTransition: transition === 1,
        activeConnections
      };
    } catch (err) {
      logger.warn('Failed to register presence connection in Redis', {
        component: 'PresenceManager',
        userId,
        connectionId,
        error: err instanceof Error ? err.message : String(err)
      });
      return {
        isOnlineTransition: false,
        activeConnections: 0
      };
    }
  }

  /**
   * Removes an exact connection lease for a user from the distributed Redis ZSET.
   * Atomically prunes expired leases and determines whether this caused a 1 -> 0 transition (OFFLINE).
   */
  public async removeConnection(
    userId: string,
    connectionId: string,
    customNowMs?: number
  ): Promise<PresenceRemovalResult> {
    if (!userId || !connectionId) {
      throw new Error('userId and connectionId are required for presence removal');
    }

    this.localConnections.delete(connectionId);

    const now = customNowMs ?? Date.now();

    try {
      const transition = await executeRemovePresence(
        this.redisClient,
        userId,
        this.instanceId,
        connectionId,
        now,
        this.keySafeguardTtlSec
      );

      const activeConnections = await this.getUserConnectionCount(userId, now);

      logger.info('Presence connection removed', {
        component: 'PresenceManager',
        userId,
        connectionId,
        instanceId: this.instanceId,
        isOfflineTransition: transition === 1,
        activeConnections
      });

      return {
        isOfflineTransition: transition === 1,
        activeConnections
      };
    } catch (err) {
      logger.warn('Failed to remove presence connection in Redis', {
        component: 'PresenceManager',
        userId,
        connectionId,
        error: err instanceof Error ? err.message : String(err)
      });
      return {
        isOfflineTransition: false,
        activeConnections: 0
      };
    }
  }

  /**
   * Returns the count of active, unexpired connection leases for a user across all instances.
   */
  public async getUserConnectionCount(
    userId: string,
    nowMs: number = Date.now()
  ): Promise<number> {
    try {
      const userKey = getPresenceUserKey(userId);
      await this.redisClient.zremrangebyscore(userKey, '-inf', nowMs);
      return await this.redisClient.zcard(userKey);
    } catch (err) {
      logger.warn('Failed to query user connection count from Redis', {
        component: 'PresenceManager',
        userId,
        error: err instanceof Error ? err.message : String(err)
      });
      return 0;
    }
  }

  /**
   * Checks if a user has at least one active, unexpired connection anywhere in the cluster.
   */
  public async isUserOnline(
    userId: string,
    nowMs: number = Date.now()
  ): Promise<boolean> {
    const count = await this.getUserConnectionCount(userId, nowMs);
    return count > 0;
  }

  /**
   * Retrieves all active, unexpired connection lease identities for a user.
   */
  public async getUserConnections(
    userId: string,
    nowMs: number = Date.now()
  ): Promise<ActiveConnectionLease[]> {
    try {
      const userKey = getPresenceUserKey(userId);
      await this.redisClient.zremrangebyscore(userKey, '-inf', nowMs);
      const members: string[] = await this.redisClient.zrangebyscore(userKey, nowMs, '+inf');
      const leases: ActiveConnectionLease[] = [];

      for (const member of members) {
        const parsed = parsePresenceMember(member);
        if (parsed) {
          leases.push(parsed);
        }
      }

      return leases;
    } catch (err) {
      logger.warn('Failed to get user active connections from Redis', {
        component: 'PresenceManager',
        userId,
        error: err instanceof Error ? err.message : String(err)
      });
      return [];
    }
  }

  /**
   * Manually prunes expired leases for a user ZSET.
   */
  public async pruneExpired(
    userId: string,
    nowMs: number = Date.now()
  ): Promise<number> {
    try {
      const userKey = getPresenceUserKey(userId);
      return await this.redisClient.zremrangebyscore(userKey, '-inf', nowMs);
    } catch (err) {
      logger.warn('Failed to prune expired presence leases', {
        component: 'PresenceManager',
        userId,
        error: err instanceof Error ? err.message : String(err)
      });
      return 0;
    }
  }

  /**
   * Retrieves current active local connections tracked on this instance.
   */
  public getLocalActiveConnections(): Array<{ userId: string; connectionId: string }> {
    return this.activeConnectionProvider
      ? this.activeConnectionProvider()
      : Array.from(this.localConnections.values());
  }

  public getLocalActiveConnectionCount(): number {
    return this.getLocalActiveConnections().length;
  }

  /**
   * Batched, pipelined renewal of all active local connection leases in Redis.
   * Conceptually:
   * local active connections -> Redis pipeline -> ZADD lease + EXPIRE key
   * Avoids writing to Redis if there are no local active connections.
   */
  public async flushLeaseRenewals(nowMs: number = Date.now()): Promise<number> {
    if (this.isFlushing) {
      return 0;
    }
    this.isFlushing = true;

    try {
      const activeConnections = this.getLocalActiveConnections();
      if (activeConnections.length === 0) {
        return 0;
      }

      const expireAt = nowMs + this.presenceTtlMs;
      const pipeline = this.redisClient.pipeline();
      const touchedUserKeys = new Set<string>();

      for (const conn of activeConnections) {
        const userKey = getPresenceUserKey(conn.userId);
        const member = formatPresenceMember(this.instanceId, conn.connectionId);
        pipeline.zadd(userKey, expireAt, member);
        touchedUserKeys.add(userKey);
      }

      for (const userKey of touchedUserKeys) {
        pipeline.expire(userKey, this.keySafeguardTtlSec);
      }

      await pipeline.exec();

      logger.debug('Flushed presence lease renewals via pipeline', {
        component: 'PresenceManager',
        instanceId: this.instanceId,
        renewedLeases: activeConnections.length,
        usersCount: touchedUserKeys.size
      });

      return activeConnections.length;
    } catch (err) {
      logger.warn('Failed to flush presence lease renewals to Redis', {
        component: 'PresenceManager',
        instanceId: this.instanceId,
        error: err instanceof Error ? err.message : String(err)
      });
      return 0;
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Starts the background lease renewal loop running every PRESENCE_FLUSH_INTERVAL_MS.
   */
  public startRenewalLoop(provider?: () => Array<{ userId: string; connectionId: string }>): void {
    if (provider) {
      this.activeConnectionProvider = provider;
    }

    if (this.renewalTimer) {
      clearInterval(this.renewalTimer);
      this.renewalTimer = undefined;
    }

    this.renewalTimer = setInterval(() => {
      this.flushLeaseRenewals().catch((err) => {
        logger.warn('Error in background presence renewal loop', {
          component: 'PresenceManager',
          instanceId: this.instanceId,
          error: err instanceof Error ? err.message : String(err)
        });
      });
    }, this.presenceFlushIntervalMs);

    if (typeof this.renewalTimer.unref === 'function') {
      this.renewalTimer.unref();
    }

    logger.info('Started presence lease renewal loop', {
      component: 'PresenceManager',
      instanceId: this.instanceId,
      flushIntervalMs: this.presenceFlushIntervalMs,
      leaseTtlMs: this.presenceTtlMs
    });
  }

  /**
   * Cleanly stops the background lease renewal loop.
   */
  public stopRenewalLoop(): void {
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer);
      this.renewalTimer = undefined;
      logger.info('Stopped presence lease renewal loop', {
        component: 'PresenceManager',
        instanceId: this.instanceId
      });
    }
  }

  public isRenewalLoopRunning(): boolean {
    return this.renewalTimer !== undefined;
  }
}
