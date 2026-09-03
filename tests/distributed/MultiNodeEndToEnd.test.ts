import { PulseServer } from '../../src/core/PulseServer.js';
import { PulseConfig } from '../../src/types/index.js';
import { RedisConnectionManager } from '../../src/redis/RedisConnectionManager.js';
import { RedisPubSubManager } from '../../src/redis/RedisPubSubManager.js';
import { Connection } from '../../src/core/Connection.js';
import RedisMock from 'ioredis-mock';
import { EventEmitter } from 'events';

describe('Phase 3 — End-to-End Multi-Node Integration', () => {
  let server1: PulseServer;
  let server2: PulseServer;
  let sharedRedisBroker: any;
  let pubSub1: RedisPubSubManager;
  let pubSub2: RedisPubSubManager;

  const createMockSocket = () => {
    const socket: any = new EventEmitter();
    socket.readyState = 1; // WebSocket.OPEN
    socket.send = jest.fn();
    socket.close = jest.fn();
    socket.terminate = jest.fn();
    socket.bufferedAmount = 0;
    return socket;
  };

  const createTestConfig = (instanceId: string, port: number): PulseConfig => ({
    port,
    host: '127.0.0.1',
    nodeEnv: 'test',
    authSecret: 'pulse-distributed-test-secret-key-32chars',
    heartbeatIntervalMs: 30000,
    heartbeatTimeoutMs: 60000,
    maxPayloadBytes: 65536,
    instanceId,
    idempotencyCapacity: 500,
    idempotencyTtlMs: 60000,
    redisEnabled: true,
    redisHost: '127.0.0.1',
    redisPort: 6379,
    redisRetryMaxAttempts: 5,
    redisRetryInitialDelayMs: 100,
    redisRetryMaxDelayMs: 1000
  });

  beforeEach(async () => {
    // PubSub for Node 1
    const conn1 = new RedisConnectionManager({
      customClientFactory: () => new RedisMock()
    }, 'pulse-node-1');
    pubSub1 = new RedisPubSubManager(conn1, 'pulse-node-1');
    await pubSub1.connect();

    // PubSub for Node 2
    const conn2 = new RedisConnectionManager({
      customClientFactory: () => new RedisMock()
    }, 'pulse-node-2');
    pubSub2 = new RedisPubSubManager(conn2, 'pulse-node-2');
    await pubSub2.connect();

    // Initialize Server 1 and Server 2 with shared Redis bus
    server1 = new PulseServer(createTestConfig('pulse-node-1', 9081), {}, { redisPubSubManager: pubSub1 });
    server2 = new PulseServer(createTestConfig('pulse-node-2', 9082), {}, { redisPubSubManager: pubSub2 });
  });

  afterEach(async () => {
    await pubSub1.disconnect();
    await pubSub2.disconnect();
  });

  test('proves multi-node scale-out: cross-node room messaging, direct messaging, echo suppression, and recovery', async () => {
    // 1. Client A (user_alice) connects to Server 1
    const socketAlice = createMockSocket();
    const connAlice = new Connection({
      socket: socketAlice,
      connectionId: 'c-alice',
      userId: 'user_alice'
    });
    server1.getConnectionManager().addConnection(connAlice);
    server1.getRoomManager().joinRoom('dev-ops', connAlice.connectionId);
    connAlice.joinRoom('dev-ops');

    // 2. Client B (user_bob) connects to Server 2
    const socketBob = createMockSocket();
    const connBob = new Connection({
      socket: socketBob,
      connectionId: 'c-bob',
      userId: 'user_bob'
    });
    server2.getConnectionManager().addConnection(connBob);
    server2.getRoomManager().joinRoom('dev-ops', connBob.connectionId);
    connBob.joinRoom('dev-ops');

    // 3. Client Charlie (user_charlie) connects to Server 2 (not in room dev-ops)
    const socketCharlie = createMockSocket();
    const connCharlie = new Connection({
      socket: socketCharlie,
      connectionId: 'c-charlie',
      userId: 'user_charlie'
    });
    server2.getConnectionManager().addConnection(connCharlie);

    // Wait for channel subscriptions to establish
    await new Promise((resolve) => setTimeout(resolve, 50));

    // ==========================================
    // A. Cross-Node Room Messaging Verification
    // ==========================================
    const roomMsg = JSON.stringify({
      eventId: '018f673a-4421-7299-8d18-0000000000e1',
      type: 'ROOM_MESSAGE',
      target: { roomId: 'dev-ops' },
      payload: { content: 'Deploying cluster build 42' }
    });

    server1.getMessageDispatcher().dispatchRawMessage(connAlice, roomMsg);

    // Allow Redis propagation to Server 2
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Bob on Server 2 received the message across nodes
    expect(socketBob.send).toHaveBeenCalledTimes(1);
    const deliveredToBob = JSON.parse(socketBob.send.mock.calls[0][0]);
    expect(deliveredToBob.type).toBe('ROOM_MESSAGE');
    expect(deliveredToBob.eventId).toBe('018f673a-4421-7299-8d18-0000000000e1');
    expect(deliveredToBob.payload.content).toBe('Deploying cluster build 42');
    expect(deliveredToBob.originInstanceId).toBe('pulse-node-1');

    // Alice on Server 1 received ONLY DELIVERY_ACK, zero message echo
    expect(socketAlice.send).toHaveBeenCalledTimes(1);
    const ackToAlice = JSON.parse(socketAlice.send.mock.calls[0][0]);
    expect(ackToAlice.type).toBe('DELIVERY_ACK');
    expect(ackToAlice.payload.targetEventId).toBe('018f673a-4421-7299-8d18-0000000000e1');

    // Charlie on Server 2 was not in dev-ops, received nothing
    expect(socketCharlie.send).not.toHaveBeenCalled();

    // ==========================================
    // B. Cross-Node Direct Messaging Verification
    // ==========================================
    const dmMsg = JSON.stringify({
      eventId: '018f673a-4421-7299-8d18-0000000000e2',
      type: 'DIRECT_MESSAGE',
      target: { recipientId: 'user_charlie' },
      payload: { text: 'Direct message from Alice to Charlie across nodes' }
    });

    server1.getMessageDispatcher().dispatchRawMessage(connAlice, dmMsg);

    await new Promise((resolve) => setTimeout(resolve, 80));

    // Charlie on Server 2 received the direct message
    expect(socketCharlie.send).toHaveBeenCalledTimes(1);
    const dmDelivered = JSON.parse(socketCharlie.send.mock.calls[0][0]);
    expect(dmDelivered.type).toBe('DIRECT_MESSAGE');
    expect(dmDelivered.eventId).toBe('018f673a-4421-7299-8d18-0000000000e2');
    expect(dmDelivered.payload.text).toBe('Direct message from Alice to Charlie across nodes');

    // Bob did NOT receive Charlie's direct message
    expect(socketBob.send).toHaveBeenCalledTimes(1); // Still only has the 1 room message

    // ==========================================
    // C. Graceful Outage and Local Isolation
    // ==========================================
    // Simulate Redis becoming unreachable for Server 1
    jest.spyOn(pubSub1, 'isConnected').mockReturnValue(false);

    // Another client connects locally to Server 1
    const socketDave = createMockSocket();
    const connDave = new Connection({
      socket: socketDave,
      connectionId: 'c-dave',
      userId: 'user_dave'
    });
    server1.getConnectionManager().addConnection(connDave);
    server1.getRoomManager().joinRoom('dev-ops', connDave.connectionId);
    connDave.joinRoom('dev-ops');

    // Alice sends another message while Redis is down
    const outageMsg = JSON.stringify({
      eventId: '018f673a-4421-7299-8d18-0000000000e3',
      type: 'ROOM_MESSAGE',
      target: { roomId: 'dev-ops' },
      payload: { content: 'Local messaging while Redis is degraded' }
    });

    server1.getMessageDispatcher().dispatchRawMessage(connAlice, outageMsg);

    // Dave (local peer on Server 1) receives the message uninterrupted
    expect(socketDave.send).toHaveBeenCalledTimes(1);
    const localDelivered = JSON.parse(socketDave.send.mock.calls[0][0]);
    expect(localDelivered.payload.content).toBe('Local messaging while Redis is degraded');
  });
});
