import { WebSocket } from 'ws';
import { Connection } from '../../src/core/Connection';
import { ConnectionManager } from '../../src/core/ConnectionManager';
import { HeartbeatManager } from '../../src/core/HeartbeatManager';

describe('HeartbeatManager (Commit 4)', () => {
  let connectionManager: ConnectionManager;
  let heartbeatManager: HeartbeatManager;

  beforeEach(() => {
    connectionManager = new ConnectionManager();
    heartbeatManager = new HeartbeatManager({
      connectionManager,
      intervalMs: 100, // 100ms interval for fast unit test
      timeoutMs: 50 // 50ms timeout
    });
  });

  afterEach(() => {
    heartbeatManager.stop();
  });

  it('sends SYS_PING to quiet connections and touches connection on response', () => {
    const sentFrames: any[] = [];
    const mockSocket = {
      readyState: WebSocket.OPEN,
      send: (data: string) => sentFrames.push(JSON.parse(data)),
      close: jest.fn()
    } as unknown as WebSocket;

    const conn = new Connection({ userId: 'alice', socket: mockSocket });
    connectionManager.addConnection(conn);

    // Simulate connection has been quiet for 120ms (>= intervalMs)
    conn.lastSeenAt = Date.now() - 120;

    heartbeatManager.checkHeartbeats();

    expect(sentFrames.length).toBe(1);
    expect(sentFrames[0].type).toBe('SYS_PING');
    expect(mockSocket.close).not.toHaveBeenCalled();
  });

  it('reaps dead connection when elapsed time exceeds interval + timeout', () => {
    const mockSocket = {
      readyState: WebSocket.OPEN,
      send: jest.fn(),
      close: jest.fn()
    } as unknown as WebSocket;

    const conn = new Connection({ userId: 'bob', socket: mockSocket });
    connectionManager.addConnection(conn);

    // Simulate elapsed time is 200ms (> 100ms + 50ms)
    conn.lastSeenAt = Date.now() - 200;

    heartbeatManager.checkHeartbeats();

    expect(mockSocket.close).toHaveBeenCalledWith(
      1002,
      'Heartbeat timeout: connection unresponsive'
    );
  });

  it('starts and stops timers cleanly', () => {
    expect(heartbeatManager.getIsRunning()).toBe(false);
    heartbeatManager.start();
    expect(heartbeatManager.getIsRunning()).toBe(true);
    heartbeatManager.stop();
    expect(heartbeatManager.getIsRunning()).toBe(false);
  });
});
