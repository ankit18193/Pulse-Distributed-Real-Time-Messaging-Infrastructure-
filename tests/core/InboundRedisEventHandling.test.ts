import { MessageDispatcher } from '../../src/core/MessageDispatcher.js';
import { ConnectionManager } from '../../src/core/ConnectionManager.js';
import { RoomManager } from '../../src/core/RoomManager.js';
import { Connection } from '../../src/core/Connection.js';
import { EventEmitter } from 'events';

describe('MessageDispatcher Inbound Redis Event Handling', () => {
  let connectionManager: ConnectionManager;
  let roomManager: RoomManager;
  let dispatcher: MessageDispatcher;

  const createMockSocket = () => {
    const socket: any = new EventEmitter();
    socket.readyState = 1; // OPEN
    socket.send = jest.fn();
    socket.close = jest.fn();
    socket.terminate = jest.fn();
    socket.bufferedAmount = 0;
    return socket;
  };

  beforeEach(() => {
    connectionManager = new ConnectionManager();
    roomManager = new RoomManager();

    dispatcher = new MessageDispatcher({
      connectionManager,
      roomManager,
      instanceId: 'node-charlie'
    });
  });

  test('validates incoming distributed Redis envelope', () => {
    // Malformed JSON
    expect(dispatcher.handleInboundRedisEvent('pulse:room:dev', '{bad json')).toBe(false);

    // Missing originInstanceId
    const invalidEnvelope = JSON.stringify({
      eventId: '018f673a-4421-7299-8d18-000000000001',
      type: 'ROOM_MESSAGE',
      timestamp: Date.now(),
      senderId: 'remote-user',
      target: { roomId: 'dev' },
      payload: { text: 'hi' }
    });
    expect(dispatcher.handleInboundRedisEvent('pulse:room:dev', invalidEnvelope)).toBe(false);
  });

  test('delivers valid remote ROOM_MESSAGE to local room members', () => {
    const socket1 = createMockSocket();
    const socket2 = createMockSocket();

    const conn1 = new Connection({ socket: socket1, connectionId: 'c1', userId: 'user-1' });
    const conn2 = new Connection({ socket: socket2, connectionId: 'c2', userId: 'user-2' });

    connectionManager.addConnection(conn1);
    connectionManager.addConnection(conn2);

    roomManager.joinRoom('alpha', 'c1');
    conn1.joinRoom('alpha');
    // conn2 is not in room alpha

    const remoteRoomEvent = {
      eventId: '018f673a-4421-7299-8d18-000000000002',
      type: 'ROOM_MESSAGE',
      timestamp: Date.now(),
      senderId: 'user-remote',
      originInstanceId: 'node-alpha', // Remote node
      target: { roomId: 'alpha' },
      payload: { message: 'Greetings from Node Alpha' }
    };

    const handled = dispatcher.handleInboundRedisEvent('pulse:room:alpha', remoteRoomEvent);
    expect(handled).toBe(true);

    // conn1 is in room alpha -> received frame
    expect(socket1.send).toHaveBeenCalledTimes(1);
    const receivedFrame = JSON.parse(socket1.send.mock.calls[0][0]);
    expect(receivedFrame.payload.message).toBe('Greetings from Node Alpha');

    // conn2 is NOT in room alpha -> received nothing
    expect(socket2.send).not.toHaveBeenCalled();
  });

  test('delivers valid remote DIRECT_MESSAGE to local recipient sockets', () => {
    const socketAliceDevice1 = createMockSocket();
    const socketAliceDevice2 = createMockSocket();
    const socketBob = createMockSocket();

    const connAlice1 = new Connection({ socket: socketAliceDevice1, connectionId: 'a1', userId: 'alice' });
    const connAlice2 = new Connection({ socket: socketAliceDevice2, connectionId: 'a2', userId: 'alice' });
    const connBob = new Connection({ socket: socketBob, connectionId: 'b1', userId: 'bob' });

    connectionManager.addConnection(connAlice1);
    connectionManager.addConnection(connAlice2);
    connectionManager.addConnection(connBob);

    const remoteDirectEvent = {
      eventId: '018f673a-4421-7299-8d18-000000000003',
      type: 'DIRECT_MESSAGE',
      timestamp: Date.now(),
      senderId: 'charlie',
      originInstanceId: 'node-beta',
      target: { recipientId: 'alice' },
      payload: { message: 'Secret DM for Alice' }
    };

    const handled = dispatcher.handleInboundRedisEvent('pulse:user:alice', remoteDirectEvent);
    expect(handled).toBe(true);

    // Both of Alice's devices receive the DM
    expect(socketAliceDevice1.send).toHaveBeenCalledTimes(1);
    expect(socketAliceDevice2.send).toHaveBeenCalledTimes(1);
    // Bob receives nothing
    expect(socketBob.send).not.toHaveBeenCalled();
  });

  test('performs local idempotency check and suppresses duplicate inbound Redis events', () => {
    const socket = createMockSocket();
    const conn = new Connection({ socket, connectionId: 'c1', userId: 'alice' });
    connectionManager.addConnection(conn);
    roomManager.joinRoom('dev', 'c1');
    conn.joinRoom('dev');

    const event = {
      eventId: '018f673a-4421-7299-8d18-000000000004',
      type: 'ROOM_MESSAGE',
      timestamp: Date.now(),
      senderId: 'bob',
      originInstanceId: 'node-remote',
      target: { roomId: 'dev' },
      payload: { content: 'Idempotency test' }
    };

    // First arrival
    const handled1 = dispatcher.handleInboundRedisEvent('pulse:room:dev', event);
    expect(handled1).toBe(true);
    expect(socket.send).toHaveBeenCalledTimes(1);

    // Second arrival of identical eventId
    const handled2 = dispatcher.handleInboundRedisEvent('pulse:room:dev', event);
    expect(handled2).toBe(false); // Suppressed by idempotency!

    // Socket still only received 1 message
    expect(socket.send).toHaveBeenCalledTimes(1);
  });

  test('does not reject Redis events based on connection-local sequence numbers', () => {
    const socket = createMockSocket();
    const conn = new Connection({ socket, connectionId: 'c1', userId: 'alice' });
    conn.lastSeenSeq = 100; // Local connection is at seq 100
    connectionManager.addConnection(conn);
    roomManager.joinRoom('dev', 'c1');
    conn.joinRoom('dev');

    // Redis event has NO seq (or seq=1 from sender's local socket)
    const event = {
      eventId: '018f673a-4421-7299-8d18-000000000005',
      type: 'ROOM_MESSAGE',
      timestamp: Date.now(),
      senderId: 'remote-sender',
      originInstanceId: 'node-remote',
      target: { roomId: 'dev' },
      payload: { content: 'Sequence free distributed event' }
    };

    const handled = dispatcher.handleInboundRedisEvent('pulse:room:dev', event);
    expect(handled).toBe(true);
    expect(socket.send).toHaveBeenCalledTimes(1);
    // Local connection lastSeenSeq is unaffected by distributed events
    expect(conn.lastSeenSeq).toBe(100);
  });
});
