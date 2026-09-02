import { RoomManager } from '../../src/core/RoomManager';

describe('RoomManager (Commit 3)', () => {
  let roomManager: RoomManager;

  beforeEach(() => {
    roomManager = new RoomManager();
  });

  it('manages room memberships and prunes empty rooms', () => {
    expect(roomManager.getRoomCount()).toBe(0);

    // Join room
    const isNew1 = roomManager.joinRoom('dev-chat', 'conn_1');
    expect(isNew1).toBe(true);
    expect(roomManager.getRoomCount()).toBe(1);
    expect(roomManager.getConnectionCountInRoom('dev-chat')).toBe(1);
    expect(roomManager.isConnectionInRoom('dev-chat', 'conn_1')).toBe(true);

    // Duplicate join
    const isNewDuplicate = roomManager.joinRoom('dev-chat', 'conn_1');
    expect(isNewDuplicate).toBe(false);

    // Second connection joins
    roomManager.joinRoom('dev-chat', 'conn_2');
    expect(roomManager.getConnectionCountInRoom('dev-chat')).toBe(2);
    expect(roomManager.getRoomConnectionIds('dev-chat')).toEqual(['conn_1', 'conn_2']);

    // Leave room
    const removed1 = roomManager.leaveRoom('dev-chat', 'conn_1');
    expect(removed1).toBe(true);
    expect(roomManager.getConnectionCountInRoom('dev-chat')).toBe(1);
    expect(roomManager.isConnectionInRoom('dev-chat', 'conn_1')).toBe(false);

    // Last member leaves -> room auto-pruned
    const removed2 = roomManager.leaveRoom('dev-chat', 'conn_2');
    expect(removed2).toBe(true);
    expect(roomManager.getRoomCount()).toBe(0);
    expect(roomManager.getRoomConnectionIds('dev-chat')).toEqual([]);
  });

  it('removes connection from all rooms on disconnect', () => {
    roomManager.joinRoom('room_a', 'conn_x');
    roomManager.joinRoom('room_b', 'conn_x');
    roomManager.joinRoom('room_a', 'conn_y');

    expect(roomManager.getRoomCount()).toBe(2);

    const removed = roomManager.removeConnectionFromAllRooms('conn_x', ['room_a', 'room_b']);
    expect(removed).toContain('room_a');
    expect(removed).toContain('room_b');

    // conn_y is still in room_a
    expect(roomManager.isConnectionInRoom('room_a', 'conn_y')).toBe(true);
    expect(roomManager.isConnectionInRoom('room_a', 'conn_x')).toBe(false);

    // room_b should now be empty and pruned
    expect(roomManager.getRoomCount()).toBe(1);
    expect(roomManager.getAllRoomIds()).toEqual(['room_a']);
  });
});
