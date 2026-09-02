import { logger } from '../utils/logger.js';

export class RoomManager {
  private readonly rooms: Map<string, Set<string>> = new Map();

  public joinRoom(roomId: string, connectionId: string): boolean {
    let members = this.rooms.get(roomId);
    if (!members) {
      members = new Set<string>();
      this.rooms.set(roomId, members);
    }

    const isNew = !members.has(connectionId);
    members.add(connectionId);

    logger.debug('Connection joined room', {
      component: 'RoomManager',
      event: 'ROOM_JOINED',
      roomId,
      connectionId,
      roomMemberCount: members.size
    });

    return isNew;
  }

  public leaveRoom(roomId: string, connectionId: string): boolean {
    const members = this.rooms.get(roomId);
    if (!members) {
      return false;
    }

    const removed = members.delete(connectionId);
    if (members.size === 0) {
      this.rooms.delete(roomId);
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
        members.delete(connectionId);
        removedRooms.push(roomId);
        if (members.size === 0) {
          this.rooms.delete(roomId);
        }
      }
    }

    return removedRooms;
  }

  public clear(): void {
    this.rooms.clear();
  }
}
