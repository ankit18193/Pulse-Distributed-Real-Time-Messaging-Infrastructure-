import { MessageDispatcher } from '../../src/core/MessageDispatcher.js';
import { ConnectionManager } from '../../src/core/ConnectionManager.js';
import { RoomManager } from '../../src/core/RoomManager.js';
import { Connection } from '../../src/core/Connection.js';
import { PulseEventEnvelope } from '../../src/types/index.js';
import { CHANNEL_PRESENCE_EVENTS } from '../../src/redis/RedisPubSubManager.js';

describe('Room-Scoped Presence Fanout', () => {
  let connectionManager: ConnectionManager;
  let roomManager: RoomManager;
  let dispatcher: MessageDispatcher;

  const createMockSocket = () => ({
    readyState: 1, // OPEN
    bufferedAmount: 0,
    send: jest.fn(),
    close: jest.fn()
  });

  beforeEach(() => {
    connectionManager = new ConnectionManager();
    roomManager = new RoomManager();
    dispatcher = new MessageDispatcher({
      connectionManager,
      roomManager,
      instanceId: 'node-fanout-test'
    });
  });

  it('delivers presence updates ONLY to clients sharing a room with target user', () => {
    // Bob is in 'engineering'
    const socketBob = createMockSocket();
    const connBob = new Connection({ connectionId: 'c-bob', userId: 'bob', socket: socketBob as any });
    connectionManager.addConnection(connBob);
    roomManager.joinRoom('engineering', 'c-bob');

    // Charlie is in 'random' (different room)
    const socketCharlie = createMockSocket();
    const connCharlie = new Connection({ connectionId: 'c-charlie', userId: 'charlie', socket: socketCharlie as any });
    connectionManager.addConnection(connCharlie);
    roomManager.joinRoom('random', 'c-charlie');

    // Dave is in no rooms
    const socketDave = createMockSocket();
    const connDave = new Connection({ connectionId: 'c-dave', userId: 'dave', socket: socketDave as any });
    connectionManager.addConnection(connDave);

    // Remote presence update arrives for Alice who is in 'engineering'
    const envelope: PulseEventEnvelope = {
      eventId: 'evt-alice-online',
      type: 'PRESENCE_UPDATE',
      timestamp: Date.now(),
      senderId: 'system',
      originInstanceId: 'remote-node-1',
      payload: {
        userId: 'alice',
        status: 'ONLINE',
        activeConnections: 1,
        rooms: ['engineering']
      }
    };

    dispatcher.handleInboundRedisEvent(CHANNEL_PRESENCE_EVENTS, JSON.stringify(envelope));

    // Bob receives the frame
    expect(socketBob.send).toHaveBeenCalledTimes(1);
    const sentData = JSON.parse(socketBob.send.mock.calls[0][0]);
    expect(sentData.eventId).toBe('evt-alice-online');
    expect(sentData.payload.userId).toBe('alice');

    // Charlie (different room) receives NOTHING
    expect(socketCharlie.send).not.toHaveBeenCalled();

    // Dave (no room) receives NOTHING
    expect(socketDave.send).not.toHaveBeenCalled();
  });

  it('deduplicates across multiple shared rooms so client receives frame strictly ONCE', () => {
    // Eve is in BOTH 'engineering' and 'product'
    const socketEve = createMockSocket();
    const connEve = new Connection({ connectionId: 'c-eve', userId: 'eve', socket: socketEve as any });
    connectionManager.addConnection(connEve);
    roomManager.joinRoom('engineering', 'c-eve');
    roomManager.joinRoom('product', 'c-eve');

    // Alice arrives in BOTH 'engineering' and 'product'
    const envelope: PulseEventEnvelope = {
      eventId: 'evt-alice-both-rooms',
      type: 'PRESENCE_UPDATE',
      timestamp: Date.now(),
      senderId: 'system',
      originInstanceId: 'remote-node-1',
      payload: {
        userId: 'alice',
        status: 'ONLINE',
        activeConnections: 1,
        rooms: ['engineering', 'product']
      }
    };

    dispatcher.handleInboundRedisEvent(CHANNEL_PRESENCE_EVENTS, JSON.stringify(envelope));

    // Eve must receive the frame exactly ONCE, not once per shared room
    expect(socketEve.send).toHaveBeenCalledTimes(1);
  });

  it('delivers frame to multiple devices of the same user without duplicate deliveries', () => {
    // Frank has 2 devices, both in 'engineering'
    const socketFrankPhone = createMockSocket();
    const connPhone = new Connection({ connectionId: 'c-frank-phone', userId: 'frank', socket: socketFrankPhone as any });
    connectionManager.addConnection(connPhone);
    roomManager.joinRoom('engineering', 'c-frank-phone');

    const socketFrankLaptop = createMockSocket();
    const connLaptop = new Connection({ connectionId: 'c-frank-laptop', userId: 'frank', socket: socketFrankLaptop as any });
    connectionManager.addConnection(connLaptop);
    roomManager.joinRoom('engineering', 'c-frank-laptop');

    const envelope: PulseEventEnvelope = {
      eventId: 'evt-alice-multi-dev',
      type: 'PRESENCE_UPDATE',
      timestamp: Date.now(),
      senderId: 'system',
      originInstanceId: 'remote-node-1',
      payload: {
        userId: 'alice',
        status: 'ONLINE',
        activeConnections: 1,
        rooms: ['engineering']
      }
    };

    dispatcher.handleInboundRedisEvent(CHANNEL_PRESENCE_EVENTS, JSON.stringify(envelope));

    // Both devices receive the event, exactly once each
    expect(socketFrankPhone.send).toHaveBeenCalledTimes(1);
    expect(socketFrankLaptop.send).toHaveBeenCalledTimes(1);
  });

  it('does NOT deliver presence events to unauthenticated connections', () => {
    const socketAnon = createMockSocket();
    const connAnon = new Connection({ connectionId: 'c-anon', userId: '', socket: socketAnon as any });
    connectionManager.addConnection(connAnon);
    roomManager.joinRoom('engineering', 'c-anon');

    const envelope: PulseEventEnvelope = {
      eventId: 'evt-pres-anon-test',
      type: 'PRESENCE_UPDATE',
      timestamp: Date.now(),
      senderId: 'system',
      originInstanceId: 'remote-node-1',
      payload: {
        userId: 'alice',
        status: 'ONLINE',
        activeConnections: 1,
        rooms: ['engineering']
      }
    };

    dispatcher.handleInboundRedisEvent(CHANNEL_PRESENCE_EVENTS, JSON.stringify(envelope));
    expect(socketAnon.send).not.toHaveBeenCalled();
  });

  it('falls back to local room inspection when hint rooms are omitted', () => {
    // Local room 'alpha' contains Alice and Bob
    const socketAlice = createMockSocket();
    const connAlice = new Connection({ connectionId: 'c-alice', userId: 'alice', socket: socketAlice as any });
    connectionManager.addConnection(connAlice);
    roomManager.joinRoom('alpha', 'c-alice');

    const socketBob = createMockSocket();
    const connBob = new Connection({ connectionId: 'c-bob', userId: 'bob', socket: socketBob as any });
    connectionManager.addConnection(connBob);
    roomManager.joinRoom('alpha', 'c-bob');

    // Charlie is in 'beta'
    const socketCharlie = createMockSocket();
    const connCharlie = new Connection({ connectionId: 'c-charlie', userId: 'charlie', socket: socketCharlie as any });
    connectionManager.addConnection(connCharlie);
    roomManager.joinRoom('beta', 'c-charlie');

    // Presence update without rooms hint
    const envelope: PulseEventEnvelope = {
      eventId: 'evt-pres-no-hint',
      type: 'PRESENCE_UPDATE',
      timestamp: Date.now(),
      senderId: 'system',
      originInstanceId: 'remote-node-1',
      payload: {
        userId: 'alice',
        status: 'OFFLINE',
        activeConnections: 0
      }
    };

    dispatcher.handleInboundRedisEvent(CHANNEL_PRESENCE_EVENTS, JSON.stringify(envelope));

    // Bob receives because he shares 'alpha' with Alice
    expect(socketBob.send).toHaveBeenCalledTimes(1);
    // Charlie receives nothing
    expect(socketCharlie.send).not.toHaveBeenCalled();
  });
});
