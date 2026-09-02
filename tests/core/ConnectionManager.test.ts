import { WebSocket } from 'ws';
import { Connection } from '../../src/core/Connection';
import { ConnectionManager } from '../../src/core/ConnectionManager';

describe('ConnectionManager (Commit 2)', () => {
  let manager: ConnectionManager;
  const mockSocket = {} as WebSocket;

  beforeEach(() => {
    manager = new ConnectionManager();
  });

  it('registers and retrieves connections by connectionId', () => {
    const conn = new Connection({
      userId: 'user_1',
      socket: mockSocket,
      roles: ['user']
    });

    manager.addConnection(conn);
    expect(manager.getCount()).toBe(1);
    expect(manager.getUserCount()).toBe(1);
    expect(manager.getConnection(conn.connectionId)).toBe(conn);
  });

  it('tracks multiple connections for a single user', () => {
    const conn1 = new Connection({
      userId: 'user_multi',
      socket: mockSocket,
      roles: ['user']
    });
    const conn2 = new Connection({
      userId: 'user_multi',
      socket: mockSocket,
      roles: ['user']
    });

    manager.addConnection(conn1);
    manager.addConnection(conn2);

    expect(manager.getCount()).toBe(2);
    expect(manager.getUserCount()).toBe(1); // Same user

    const userConns = manager.getConnectionsByUserId('user_multi');
    expect(userConns.length).toBe(2);
    expect(userConns).toContain(conn1);
    expect(userConns).toContain(conn2);
  });

  it('removes connection and updates user mapping cleanly', () => {
    const conn1 = new Connection({ userId: 'user_multi', socket: mockSocket });
    const conn2 = new Connection({ userId: 'user_multi', socket: mockSocket });

    manager.addConnection(conn1);
    manager.addConnection(conn2);

    // Remove first connection
    const removed1 = manager.removeConnection(conn1.connectionId);
    expect(removed1).toBe(conn1);
    expect(conn1.getIsCleanedUp()).toBe(true);
    expect(manager.getCount()).toBe(1);
    expect(manager.getUserCount()).toBe(1); // Still 1 user active

    // Remove second connection
    manager.removeConnection(conn2.connectionId);
    expect(manager.getCount()).toBe(0);
    expect(manager.getUserCount()).toBe(0); // User is now fully gone
    expect(manager.getConnectionsByUserId('user_multi')).toEqual([]);
  });

  it('returns empty array when querying non-existent user', () => {
    expect(manager.getConnectionsByUserId('unknown_user')).toEqual([]);
    expect(manager.getConnection('unknown_conn_id')).toBeUndefined();
  });
});
