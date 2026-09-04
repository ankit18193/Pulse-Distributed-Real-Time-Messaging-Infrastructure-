import RedisMock from 'ioredis-mock';
import { PresenceManager } from '../../src/redis/PresenceManager.js';
import { MessageDispatcher } from '../../src/core/MessageDispatcher.js';
import { ConnectionManager } from '../../src/core/ConnectionManager.js';
import { RoomManager } from '../../src/core/RoomManager.js';
import { Connection } from '../../src/core/Connection.js';
import { RedisPubSubManager, CHANNEL_PRESENCE_EVENTS } from '../../src/redis/RedisPubSubManager.js';
import { RedisConnectionManager } from '../../src/redis/RedisConnectionManager.js';
import { PulseEventEnvelope, PresenceUpdatePayload } from '../../src/types/index.js';

describe('Cross-Node Presence Isolation & Lifecycle (Node A <-> Node B)', () => {
  let redisStorage: any;

  let pubSubNodeA: RedisPubSubManager;
  let pubSubNodeB: RedisPubSubManager;

  let presenceNodeA: PresenceManager;
  let presenceNodeB: PresenceManager;

  let connMgrA: ConnectionManager;
  let connMgrB: ConnectionManager;

  let roomMgrA: RoomManager;
  let roomMgrB: RoomManager;

  let dispatcherA: MessageDispatcher;
  let dispatcherB: MessageDispatcher;

  const createMockSocket = () => ({
    readyState: 1, // WebSocket.OPEN
    bufferedAmount: 0,
    send: jest.fn(),
    close: jest.fn()
  });

  beforeEach(async () => {
    redisStorage = new (RedisMock as any)();

    const rcMgrA = new RedisConnectionManager({
      customClientFactory: () => new (RedisMock as any)()
    });
    const rcMgrB = new RedisConnectionManager({
      customClientFactory: () => new (RedisMock as any)()
    });

    pubSubNodeA = new RedisPubSubManager(rcMgrA, 'node-A');
    pubSubNodeB = new RedisPubSubManager(rcMgrB, 'node-B');

    await pubSubNodeA.connect();
    await pubSubNodeB.connect();

    connMgrA = new ConnectionManager();
    connMgrB = new ConnectionManager();

    roomMgrA = new RoomManager();
    roomMgrB = new RoomManager();

    presenceNodeA = new PresenceManager(redisStorage, 'node-A', {
      pubSubManager: pubSubNodeA,
      roomsProvider: (userId) => {
        const conns = connMgrA.getConnectionsByUserId(userId);
        return Array.from(new Set(conns.flatMap((c) => c.getRooms())));
      }
    });

    presenceNodeB = new PresenceManager(redisStorage, 'node-B', {
      pubSubManager: pubSubNodeB,
      roomsProvider: (userId) => {
        const conns = connMgrB.getConnectionsByUserId(userId);
        return Array.from(new Set(conns.flatMap((c) => c.getRooms())));
      }
    });

    dispatcherA = new MessageDispatcher({
      connectionManager: connMgrA,
      roomManager: roomMgrA,
      redisPubSubManager: pubSubNodeA,
      presenceManager: presenceNodeA,
      instanceId: 'node-A'
    });

    dispatcherB = new MessageDispatcher({
      connectionManager: connMgrB,
      roomManager: roomMgrB,
      redisPubSubManager: pubSubNodeB,
      presenceManager: presenceNodeB,
      instanceId: 'node-B'
    });
  });

  afterEach(async () => {
    await pubSubNodeA.disconnect();
    await pubSubNodeB.disconnect();
    await redisStorage.flushall();
  });

  it('delivers presence updates to cross-node users sharing a room (Shared Room Test)', async () => {
    // Setup Bob on Node B in room 'lobby'
    const socketBob = createMockSocket();
    const connBob = new Connection({ connectionId: 'conn-bob-1', userId: 'bob', socket: socketBob as any });
    connBob.joinRoom('lobby');
    connMgrB.addConnection(connBob);
    roomMgrB.joinRoom('lobby', 'conn-bob-1');

    // Intercept publish from Node A and route to Node B
    const publishSpyA = jest.spyOn(pubSubNodeA, 'publishPresence').mockImplementation(async (env: any) => {
      dispatcherB.handleInboundRedisEvent(CHANNEL_PRESENCE_EVENTS, JSON.stringify(env));
      return 1;
    });

    // Alice connects on Node A in room 'lobby'
    const socketAlice = createMockSocket();
    const connAlice = new Connection({ connectionId: 'conn-alice-1', userId: 'alice', socket: socketAlice as any });
    connAlice.joinRoom('lobby');
    connMgrA.addConnection(connAlice);
    roomMgrA.joinRoom('lobby', 'conn-alice-1');

    const regResult = await presenceNodeA.registerConnection('alice', 'conn-alice-1');
    expect(regResult.isOnlineTransition).toBe(true);
    expect(publishSpyA).toHaveBeenCalledTimes(1);

    // Verify Bob on Node B received Alice's ONLINE event
    expect(socketBob.send).toHaveBeenCalledTimes(1);
    const sentFrame = JSON.parse(socketBob.send.mock.calls[0][0]);
    expect(sentFrame.type).toBe('PRESENCE_UPDATE');
    expect(sentFrame.originInstanceId).toBe('node-A');
    expect(sentFrame.payload.userId).toBe('alice');
    expect(sentFrame.payload.status).toBe('ONLINE');
    expect(sentFrame.payload.rooms).toContain('lobby');
  });

  it('isolates presence updates from cross-node users in different rooms (Different Rooms Test)', async () => {
    // Setup Bob on Node B in room 'room-backend'
    const socketBob = createMockSocket();
    const connBob = new Connection({ connectionId: 'conn-bob-diff', userId: 'bob', socket: socketBob as any });
    connBob.joinRoom('room-backend');
    connMgrB.addConnection(connBob);
    roomMgrB.joinRoom('room-backend', 'conn-bob-diff');

    // Route Node A publishes to Node B
    jest.spyOn(pubSubNodeA, 'publishPresence').mockImplementation(async (env: any) => {
      dispatcherB.handleInboundRedisEvent(CHANNEL_PRESENCE_EVENTS, JSON.stringify(env));
      return 1;
    });

    // Alice connects on Node A in room 'room-frontend'
    const socketAlice = createMockSocket();
    const connAlice = new Connection({ connectionId: 'conn-alice-diff', userId: 'alice', socket: socketAlice as any });
    connAlice.joinRoom('room-frontend');
    connMgrA.addConnection(connAlice);
    roomMgrA.joinRoom('room-frontend', 'conn-alice-diff');

    await presenceNodeA.registerConnection('alice', 'conn-alice-diff');

    // Bob must NOT receive Alice's presence update (different rooms isolation)
    expect(socketBob.send).not.toHaveBeenCalled();
  });

  it('aggregates multi-device connections: ONLINE on 0 -> 1, OFFLINE only on 1 -> 0', async () => {
    const socketBob = createMockSocket();
    const connBob = new Connection({ connectionId: 'conn-bob-shared', userId: 'bob', socket: socketBob as any });
    connBob.joinRoom('general');
    connMgrB.addConnection(connBob);
    roomMgrB.joinRoom('general', 'conn-bob-shared');

    jest.spyOn(pubSubNodeA, 'publishPresence').mockImplementation(async (env: any) => {
      dispatcherB.handleInboundRedisEvent(CHANNEL_PRESENCE_EVENTS, JSON.stringify(env));
      return 1;
    });

    // Alice connects Device 1 (laptop)
    const socketAlice1 = createMockSocket();
    const connAlice1 = new Connection({ connectionId: 'c-alice-laptop', userId: 'alice', socket: socketAlice1 as any });
    connAlice1.joinRoom('general');
    connMgrA.addConnection(connAlice1);
    roomMgrA.joinRoom('general', 'c-alice-laptop');

    await presenceNodeA.registerConnection('alice', 'c-alice-laptop');
    // Bob receives ONLINE
    expect(socketBob.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(socketBob.send.mock.calls[0][0]).payload.status).toBe('ONLINE');

    // Alice connects Device 2 (phone)
    const socketAlice2 = createMockSocket();
    const connAlice2 = new Connection({ connectionId: 'c-alice-phone', userId: 'alice', socket: socketAlice2 as any });
    connAlice2.joinRoom('general');
    connMgrA.addConnection(connAlice2);
    roomMgrA.joinRoom('general', 'c-alice-phone');

    await presenceNodeA.registerConnection('alice', 'c-alice-phone');
    // Bob should still have received only 1 frame (no duplicate ONLINE)
    expect(socketBob.send).toHaveBeenCalledTimes(1);

    // Alice disconnects Device 1 (laptop) -> partial disconnect, still online on phone
    connMgrA.removeConnection('c-alice-laptop');
    roomMgrA.leaveRoom('general', 'c-alice-laptop');
    await presenceNodeA.removeConnection('alice', 'c-alice-laptop', undefined, ['general']);
    // Bob should still have received only 1 frame (no OFFLINE yet)
    expect(socketBob.send).toHaveBeenCalledTimes(1);

    // Alice disconnects Device 2 (phone) -> final disconnect
    connMgrA.removeConnection('c-alice-phone');
    roomMgrA.leaveRoom('general', 'c-alice-phone');
    await presenceNodeA.removeConnection('alice', 'c-alice-phone', undefined, ['general']);
    // Bob now receives OFFLINE frame
    expect(socketBob.send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(socketBob.send.mock.calls[1][0]).payload.status).toBe('OFFLINE');
  });

  it('suppresses self-echo loopback on Node A', () => {
    const socketAlice = createMockSocket();
    const connAlice = new Connection({ connectionId: 'c-alice-echo', userId: 'alice', socket: socketAlice as any });
    connAlice.joinRoom('general');
    connMgrA.addConnection(connAlice);
    roomMgrA.joinRoom('general', 'c-alice-echo');

    const selfEchoEnvelope: PulseEventEnvelope = {
      eventId: 'evt-self-echo-check',
      type: 'PRESENCE_UPDATE',
      timestamp: Date.now(),
      senderId: 'system',
      originInstanceId: 'node-A',
      payload: {
        userId: 'alice',
        status: 'ONLINE',
        activeConnections: 1,
        rooms: ['general']
      }
    };

    const handled = dispatcherA.handleInboundRedisEvent(CHANNEL_PRESENCE_EVENTS, JSON.stringify(selfEchoEnvelope));
    expect(handled).toBe(false);
    expect(socketAlice.send).not.toHaveBeenCalled();
  });

  it('suppresses duplicate inbound presence frames via IdempotencyManager', () => {
    const socketBob = createMockSocket();
    const connBob = new Connection({ connectionId: 'c-bob-dup', userId: 'bob', socket: socketBob as any });
    connBob.joinRoom('chat');
    connMgrB.addConnection(connBob);
    roomMgrB.joinRoom('chat', 'c-bob-dup');

    const envelope: PulseEventEnvelope = {
      eventId: 'evt-dup-check',
      type: 'PRESENCE_UPDATE',
      timestamp: Date.now(),
      senderId: 'system',
      originInstanceId: 'node-A',
      payload: {
        userId: 'alice',
        status: 'ONLINE',
        activeConnections: 1,
        rooms: ['chat']
      }
    };

    const first = dispatcherB.handleInboundRedisEvent(CHANNEL_PRESENCE_EVENTS, JSON.stringify(envelope));
    expect(first).toBe(true);
    expect(socketBob.send).toHaveBeenCalledTimes(1);

    // Duplicate message
    const second = dispatcherB.handleInboundRedisEvent(CHANNEL_PRESENCE_EVENTS, JSON.stringify(envelope));
    expect(second).toBe(false);
    expect(socketBob.send).toHaveBeenCalledTimes(1);
  });

  it('drops stale and equal-timestamp presence events via PresenceEventTracker', () => {
    const socketBob = createMockSocket();
    const connBob = new Connection({ connectionId: 'c-bob-stale', userId: 'bob', socket: socketBob as any });
    connBob.joinRoom('chat');
    connMgrB.addConnection(connBob);
    roomMgrB.joinRoom('chat', 'c-bob-stale');

    // Event 1 at timestamp 5000
    const env1: PulseEventEnvelope = {
      eventId: 'evt-ts-5000',
      type: 'PRESENCE_UPDATE',
      timestamp: 5000,
      senderId: 'system',
      originInstanceId: 'node-A',
      payload: { userId: 'alice', status: 'ONLINE', activeConnections: 1, rooms: ['chat'] }
    };
    expect(dispatcherB.handleInboundRedisEvent(CHANNEL_PRESENCE_EVENTS, JSON.stringify(env1))).toBe(true);
    expect(socketBob.send).toHaveBeenCalledTimes(1);

    // Stale Event with timestamp 4000 (older)
    const envOlder: PulseEventEnvelope = {
      eventId: 'evt-ts-4000',
      type: 'PRESENCE_UPDATE',
      timestamp: 4000,
      senderId: 'system',
      originInstanceId: 'node-A',
      payload: { userId: 'alice', status: 'OFFLINE', activeConnections: 0, rooms: ['chat'] }
    };
    expect(dispatcherB.handleInboundRedisEvent(CHANNEL_PRESENCE_EVENTS, JSON.stringify(envOlder))).toBe(false);
    expect(socketBob.send).toHaveBeenCalledTimes(1);

    // Equal timestamp event 5000 (equal timestamp rejection)
    const envEqual: PulseEventEnvelope = {
      eventId: 'evt-ts-5000-equal',
      type: 'PRESENCE_UPDATE',
      timestamp: 5000,
      senderId: 'system',
      originInstanceId: 'node-A',
      payload: { userId: 'alice', status: 'ONLINE', activeConnections: 1, rooms: ['chat'] }
    };
    expect(dispatcherB.handleInboundRedisEvent(CHANNEL_PRESENCE_EVENTS, JSON.stringify(envEqual))).toBe(false);
    expect(socketBob.send).toHaveBeenCalledTimes(1);
  });

  it('isolates completely unrelated clients (Unrelated Client Isolation)', () => {
    // Charlie is on Node B but has no rooms
    const socketCharlie = createMockSocket();
    const connCharlie = new Connection({ connectionId: 'c-charlie-solo', userId: 'charlie', socket: socketCharlie as any });
    connMgrB.addConnection(connCharlie);

    // Dan is unauthenticated
    const socketDan = createMockSocket();
    const connDan = new Connection({ connectionId: 'c-dan-anon', userId: '', socket: socketDan as any });
    connMgrB.addConnection(connDan);
    roomMgrB.joinRoom('chat', 'c-dan-anon');

    const envelope: PulseEventEnvelope = {
      eventId: 'evt-isolation-check',
      type: 'PRESENCE_UPDATE',
      timestamp: Date.now(),
      senderId: 'system',
      originInstanceId: 'node-A',
      payload: {
        userId: 'alice',
        status: 'ONLINE',
        activeConnections: 1,
        rooms: ['chat']
      }
    };

    dispatcherB.handleInboundRedisEvent(CHANNEL_PRESENCE_EVENTS, JSON.stringify(envelope));

    expect(socketCharlie.send).not.toHaveBeenCalled();
    expect(socketDan.send).not.toHaveBeenCalled();
  });
});
