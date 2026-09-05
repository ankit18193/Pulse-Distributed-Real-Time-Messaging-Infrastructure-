import type { Redis } from 'ioredis';
import {
  executeRegisterPresence,
  executeRemovePresence,
  executeGetRoomPresenceRoster,
  getPresenceUserKey,
  getRoomMembersKey,
  formatPresenceMember,
  parsePresenceMember,
  DEFAULT_KEY_SAFEGUARD_TTL_SEC
} from './PresenceLuaScripts.js';
import { PresenceEventTracker } from './PresenceEventTracker.js';
import type { PresenceStatus, PresenceUpdatePayload, PulseEventEnvelope, RoomRosterPayload } from '../types/index.js';
import type { RedisPubSubManager } from './RedisPubSubManager.js';
import { generateUUIDv7 } from '../utils/uuidv7.js';
import { logger } from '../utils/logger.js';
import type { PulseMetricsRegistry } from '../metrics/PulseMetricsRegistry.js';
import { registerPresenceMetrics } from '../metrics/telemetry.js';

export interface PresenceManagerOptions {
  presenceTtlMs?: number;
  presenceFlushIntervalMs?: number;
  keySafeguardTtlSec?: number;
  maxTrackedUsers?: number;
  pubSubManager?: RedisPubSubManager;
  roomsProvider?: (userId: string) => string[];
  localRosterProvider?: (roomId: string) => string[];
  metricsRegistry?: PulseMetricsRegistry;
}

export interface PresenceMetricsSnapshot {
  'presence.users.online': number;
  'presence.connections.active': number;
  'presence.events.published': number;
  'presence.events.received': number;
  'presence.prune.latency.ms': number;
  'presence.lease.renewals': number;
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
  private pubSubManager?: RedisPubSubManager;
  private roomsProvider?: (userId: string) => string[];
  private localRosterProvider?: (roomId: string) => string[];
  private renewalTimer?: NodeJS.Timeout;
  private isFlushing: boolean = false;
  private eventsPublished: number = 0;
  private eventsReceived: number = 0;
  private pruneLatencyMs: number = 0;
  private totalLeaseRenewals: number = 0;
  private metricsRegistry?: PulseMetricsRegistry;

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
    this.pubSubManager = options.pubSubManager;
    this.roomsProvider = options.roomsProvider;
    this.localRosterProvider = options.localRosterProvider;
    this.metricsRegistry = options.metricsRegistry;

    if (this.metricsRegistry) {
      registerPresenceMetrics(this.metricsRegistry);
    }
  }

  public setMetricsRegistry(metricsRegistry: PulseMetricsRegistry): void {
    this.metricsRegistry = metricsRegistry;
    registerPresenceMetrics(metricsRegistry);
  }

  public getMetricsRegistry(): PulseMetricsRegistry | undefined {
    return this.metricsRegistry;
  }

  public getInstanceId(): string {
    return this.instanceId;
  }

  public getPresenceFlushIntervalMs(): number {
    return this.presenceFlushIntervalMs;
  }

  public getPubSubManager(): RedisPubSubManager | undefined {
    return this.pubSubManager;
  }

  public setPubSubManager(pubSubManager: RedisPubSubManager): void {
    this.pubSubManager = pubSubManager;
  }

  public getRoomsProvider(): ((userId: string) => string[]) | undefined {
    return this.roomsProvider;
  }

  public setRoomsProvider(provider: (userId: string) => string[]): void {
    this.roomsProvider = provider;
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
    customNowMs?: number,
    customRooms?: string[]
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
      this.updateActiveMetrics();
      this.metricsRegistry?.getCounter('pulse_presence_operations_total')?.inc({ operation: 'register', status: 'success' });

      logger.info('Presence connection registered', {
        component: 'PresenceManager',
        userId,
        connectionId,
        instanceId: this.instanceId,
        isOnlineTransition: transition === 1,
        activeConnections
      });

      if (transition === 1) {
        const rooms = customRooms ?? (this.roomsProvider ? this.roomsProvider(userId) : undefined);
        await this.publishPresenceUpdate(userId, 'ONLINE', activeConnections, rooms);
      }

      return {
        isOnlineTransition: transition === 1,
        activeConnections
      };
    } catch (err) {
      this.metricsRegistry?.getCounter('pulse_presence_operations_total')?.inc({ operation: 'register', status: 'error' });
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
    customNowMs?: number,
    customRooms?: string[]
  ): Promise<PresenceRemovalResult> {
    if (!userId || !connectionId) {
      throw new Error('userId and connectionId are required for presence removal');
    }

    this.localConnections.delete(connectionId);
    this.updateActiveMetrics();

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

      if (transition === 1) {
        const rooms = customRooms ?? (this.roomsProvider ? this.roomsProvider(userId) : undefined);
        await this.publishPresenceUpdate(userId, 'OFFLINE', activeConnections, rooms);
      }

      this.metricsRegistry?.getCounter('pulse_presence_operations_total')?.inc({ operation: 'remove', status: 'success' });

      return {
        isOfflineTransition: transition === 1,
        activeConnections
      };
    } catch (err) {
      this.metricsRegistry?.getCounter('pulse_presence_operations_total')?.inc({ operation: 'remove', status: 'error' });
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
   * Publishes a PRESENCE_UPDATE distributed event to Redis Pub/Sub (pulse:presence:events).
   * Stamps the local instanceId onto originInstanceId.
   */
  public async publishPresenceUpdate(
    userId: string,
    status: PresenceStatus,
    activeConnections: number,
    rooms?: string[]
  ): Promise<void> {
    if (!this.pubSubManager || !this.pubSubManager.isConnected()) {
      return;
    }

    const payload: PresenceUpdatePayload = {
      userId,
      status,
      activeConnections,
      rooms
    };

    const envelope: PulseEventEnvelope = {
      eventId: generateUUIDv7(),
      type: 'PRESENCE_UPDATE',
      timestamp: Date.now(),
      senderId: 'system',
      originInstanceId: this.instanceId,
      originTimestampMs: Date.now(),
      payload
    };

    try {
      await this.pubSubManager.publishPresence(envelope);
      this.eventsPublished++;
      this.pubSubManager.getMetrics().recordPresenceEventPublished();
      this.metricsRegistry?.getCounter('pulse_presence_events_total')?.inc({ direction: 'published' });
      logger.info('Published distributed presence event', {
        component: 'PresenceManager',
        instanceId: this.instanceId,
        userId,
        status,
        activeConnections,
        eventId: envelope.eventId
      });
    } catch (err) {
      logger.warn('Failed to publish distributed presence event', {
        component: 'PresenceManager',
        instanceId: this.instanceId,
        userId,
        status,
        error: err instanceof Error ? err.message : String(err)
      });
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
    const start = Date.now();
    try {
      const userKey = getPresenceUserKey(userId);
      const pruned = await this.redisClient.zremrangebyscore(userKey, '-inf', nowMs);
      const latency = Date.now() - start;
      this.pruneLatencyMs = latency;
      if (this.pubSubManager) {
        this.pubSubManager.getMetrics().recordPresencePruneLatency(latency);
      }
      this.metricsRegistry?.getHistogram('pulse_presence_prune_duration_seconds')?.record(latency / 1000);
      return pruned;
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

      this.totalLeaseRenewals += activeConnections.length;
      if (this.pubSubManager) {
        this.pubSubManager.getMetrics().recordPresenceLeaseRenewals(activeConnections.length);
      }
      this.metricsRegistry?.getCounter('pulse_presence_lease_renewals_total')?.inc(undefined, activeConnections.length);

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

  /**
   * Adds a user to the Redis cluster room membership set:
   * pulse:room:{roomId}:members -> SADD userId
   *
   * Idempotent; multi-device users appear only once in the Redis SET.
   */
  public async addRoomMember(roomId: string, userId: string): Promise<void> {
    const trimmedRoom = roomId.trim();
    const trimmedUser = userId.trim();
    if (!trimmedRoom || !trimmedUser) return;

    try {
      const roomKey = getRoomMembersKey(trimmedRoom);
      await this.redisClient.sadd(roomKey, trimmedUser);
      logger.debug('Added user to room in Redis presence set', {
        component: 'PresenceManager',
        roomId: trimmedRoom,
        userId: trimmedUser
      });
    } catch (err) {
      logger.warn('Failed to add user to room membership set in Redis', {
        component: 'PresenceManager',
        roomId: trimmedRoom,
        userId: trimmedUser,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  /**
   * Removes a user from the Redis cluster room membership set:
   * pulse:room:{roomId}:members -> SREM userId
   */
  public async removeRoomMember(roomId: string, userId: string): Promise<void> {
    const trimmedRoom = roomId.trim();
    const trimmedUser = userId.trim();
    if (!trimmedRoom || !trimmedUser) return;

    try {
      const roomKey = getRoomMembersKey(trimmedRoom);
      await this.redisClient.srem(roomKey, trimmedUser);
      logger.debug('Removed user from room in Redis presence set', {
        component: 'PresenceManager',
        roomId: trimmedRoom,
        userId: trimmedUser
      });
    } catch (err) {
      logger.warn('Failed to remove user from room membership set in Redis', {
        component: 'PresenceManager',
        roomId: trimmedRoom,
        userId: trimmedUser,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  /**
   * Obtains a room presence roster snapshot:
   * 1. Reads room membership from pulse:room:{roomId}:members
   * 2. Inspects each user's presence ZSET
   * 3. Prunes expired leases
   * 4. Returns currently online user IDs
   * 5. Automatically prunes stale offline users from the room set
   *
   * If Redis is unavailable, safely falls back to local room roster (fail-open).
   */
  public async getRoomRoster(roomId: string): Promise<RoomRosterPayload> {
    const trimmedRoom = roomId.trim();
    if (!trimmedRoom) {
      return { roomId: '', members: [], totalOnline: 0 };
    }

    try {
      const now = Date.now();
      const pruneStart = Date.now();
      const onlineUserIds = await executeGetRoomPresenceRoster(this.redisClient, trimmedRoom, now);
      const pruneLatency = Date.now() - pruneStart;
      this.pruneLatencyMs = pruneLatency;
      if (this.pubSubManager) {
        this.pubSubManager.getMetrics().recordPresencePruneLatency(pruneLatency);
      }
      this.metricsRegistry?.getHistogram('pulse_presence_prune_duration_seconds')?.record(pruneLatency / 1000);
      const uniqueSorted = Array.from(new Set(onlineUserIds)).sort();
      return {
        roomId: trimmedRoom,
        members: uniqueSorted,
        totalOnline: uniqueSorted.length
      };
    } catch (err) {
      logger.warn('Failed to get room presence roster from Redis, falling back to local roster', {
        component: 'PresenceManager',
        roomId: trimmedRoom,
        error: err instanceof Error ? err.message : String(err)
      });

      const fallbackMembers = this.localRosterProvider
        ? this.localRosterProvider(trimmedRoom)
        : [];
      const uniqueFallback = Array.from(new Set(fallbackMembers)).sort();
      return {
        roomId: trimmedRoom,
        members: uniqueFallback,
        totalOnline: uniqueFallback.length
      };
    }
  }

  public setLocalRosterProvider(provider: (roomId: string) => string[]): void {
    this.localRosterProvider = provider;
  }

  public recordInboundEvent(): void {
    this.eventsReceived++;
    if (this.pubSubManager) {
      this.pubSubManager.getMetrics().recordPresenceEventReceived();
    }
    this.metricsRegistry?.getCounter('pulse_presence_events_total')?.inc({ direction: 'received' });
  }

  private updateActiveMetrics(): void {
    const userIds = new Set<string>();
    for (const { userId } of this.localConnections.values()) {
      userIds.add(userId);
    }
    const onlineUsers = userIds.size;
    const activeConns = this.localConnections.size;

    if (this.pubSubManager) {
      this.pubSubManager.getMetrics().setPresenceCounts(onlineUsers, activeConns);
    }
    this.metricsRegistry?.getGauge('pulse_presence_users_online')?.set(onlineUsers);
    this.metricsRegistry?.getGauge('pulse_presence_connections_active')?.set(activeConns);
  }

  public getMetricsSnapshot(): PresenceMetricsSnapshot {
    const userIds = new Set<string>();
    for (const { userId } of this.localConnections.values()) {
      userIds.add(userId);
    }
    return {
      'presence.users.online': userIds.size,
      'presence.connections.active': this.localConnections.size,
      'presence.events.published': this.eventsPublished,
      'presence.events.received': this.eventsReceived,
      'presence.prune.latency.ms': this.pruneLatencyMs,
      'presence.lease.renewals': this.totalLeaseRenewals
    };
  }
}
