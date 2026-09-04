import type { Redis } from 'ioredis';
import {
  executeRegisterPresence,
  executeRemovePresence,
  getPresenceUserKey,
  parsePresenceMember,
  DEFAULT_KEY_SAFEGUARD_TTL_SEC
} from './PresenceLuaScripts.js';
import { logger } from '../utils/logger.js';

export interface PresenceManagerOptions {
  presenceTtlMs?: number;
  keySafeguardTtlSec?: number;
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
  private readonly keySafeguardTtlSec: number;

  constructor(
    redisClient: Redis,
    instanceId: string = 'pulse-node-1',
    options: PresenceManagerOptions = {}
  ) {
    this.redisClient = redisClient;
    this.instanceId = instanceId;
    this.presenceTtlMs = options.presenceTtlMs ?? 60000;
    this.keySafeguardTtlSec = options.keySafeguardTtlSec ?? DEFAULT_KEY_SAFEGUARD_TTL_SEC;
  }

  public getInstanceId(): string {
    return this.instanceId;
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
}
