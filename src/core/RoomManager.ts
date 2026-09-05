import { logger } from '../utils/logger.js';
import type { ChannelRegistry } from '../redis/ChannelRegistry.js';
import type { PulseMetricsRegistry } from '../metrics/PulseMetricsRegistry.js';

export class RoomManager {
  private readonly rooms: Map<string, Set<string>> = new Map();
  private channelRegistry?: ChannelRegistry;
  private metricsRegistry?: PulseMetricsRegistry;

  constructor(channelRegistry?: ChannelRegistry, metricsRegistry?: PulseMetricsRegistry) {
    this.channelRegistry = channelRegistry;
    this.metricsRegistry = metricsRegistry;
  }

  public setMetricsRegistry(metricsRegistry: PulseMetricsRegistry): void {
    this.metricsRegistry = metricsRegistry;
  }

  public setChannelRegistry(channelRegistry: ChannelRegistry): void {
    this.channelRegistry = channelRegistry;
  }

  public getChannelRegistry(): ChannelRegistry | undefined {
    return this.channelRegistry;
  }

  public joinRoom(roomId: string, connectionId: string): boolean {
    let members = this.rooms.get(roomId);
    if (!members) {
      members = new Set<string>();
      this.rooms.set(roomId, members);
    }

    const isNew = !members.has(connectionId);
    members.add(connectionId);

    if (isNew) {
      this.metricsRegistry?.getGauge('pulse_rooms_active')?.set(this.rooms.size);
    }

    if (isNew && this.channelRegistry) {
      this.channelRegistry.subscribeRoom(roomId).catch((err) => {
        logger.warn('Failed to subscribe room in Redis channel registry', {
          component: 'RoomManager',
          roomId,
          connectionId,
          error: err instanceof Error ? err.message : String(err)
        });
      });
    }

    logger.debug('Connection joined room', {
      component: 'RoomManager',
      event: 'ROOM_JOINED',
      roomId,
      connectionId,
      roomMemberCount: members.size
    });

    return isNew;
  }

  public joinRooms(roomIds: string[], connectionId: string): string[] {
    const joined: string[] = [];
    for (const roomId of roomIds) {
      const trimmed = roomId.trim();
      if (trimmed) {
        this.joinRoom(trimmed, connectionId);
        joined.push(trimmed);
      }
    }
    return joined;
  }

  public leaveRoom(roomId: string, connectionId: string): boolean {
    const members = this.rooms.get(roomId);
    if (!members) {
      return false;
    }

    const removed = members.delete(connectionId);
    if (removed && this.channelRegistry) {
      this.channelRegistry.unsubscribeRoom(roomId).catch((err) => {
        logger.warn('Failed to unsubscribe room in Redis channel registry', {
          component: 'RoomManager',
          roomId,
          connectionId,
          error: err instanceof Error ? err.message : String(err)
        });
      });
    }

    if (members.size === 0) {
      this.rooms.delete(roomId);
      this.metricsRegistry?.getGauge('pulse_rooms_active')?.set(this.rooms.size);
      logger.debug('Room pruned after last member left', {
        component: 'RoomManager',
        event: 'ROOM_PRUNED',
        roomId
      });
    } else {
      logger.debug('Connection left room', {
        component: 'RoomManager',
        event: 'ROOM_LEFT',
        roomId,
        connectionId,
        remainingMembers: members.size
      });
    }

    return removed;
  }

  public getRoomConnectionIds(roomId: string): string[] {
    const members = this.rooms.get(roomId);
    return members ? Array.from(members) : [];
  }

  public getConnectionCountInRoom(roomId: string): number {
    const members = this.rooms.get(roomId);
    return members ? members.size : 0;
  }

  public isConnectionInRoom(roomId: string, connectionId: string): boolean {
    const members = this.rooms.get(roomId);
    return members ? members.has(connectionId) : false;
  }

  public getRoomCount(): number {
    return this.rooms.size;
  }

  public getAllRoomIds(): string[] {
    return Array.from(this.rooms.keys());
  }

  public removeConnectionFromAllRooms(
    connectionId: string,
    rooms: string[]
  ): string[] {
    const removedRooms: string[] = [];

    for (const roomId of rooms) {
      if (this.leaveRoom(roomId, connectionId)) {
        removedRooms.push(roomId);
      }
    }

    // Safety sweep: also check any other room where connectionId might exist
    for (const [roomId, members] of this.rooms.entries()) {
      if (members.has(connectionId)) {
        if (this.leaveRoom(roomId, connectionId)) {
          removedRooms.push(roomId);
        }
      }
    }

    return removedRooms;
  }

  public clear(): void {
    this.rooms.clear();
    this.metricsRegistry?.getGauge('pulse_rooms_active')?.set(0);
  }
}
