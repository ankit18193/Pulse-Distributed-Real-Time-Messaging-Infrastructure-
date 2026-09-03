import { MessageDispatcher } from '../../src/core/MessageDispatcher.js';
import { ConnectionManager } from '../../src/core/ConnectionManager.js';
import { RoomManager } from '../../src/core/RoomManager.js';
import { Connection } from '../../src/core/Connection.js';
import { PulseEventEnvelope } from '../../src/types/index.js';
import { EventEmitter } from 'events';

describe('MessageDispatcher Redis Self-Echo Suppression', () => {
  let connectionManager: ConnectionManager;
  let roomManager: RoomManager;
  let mockPubSubManager: any;
  let dispatcher: MessageDispatcher;

  const createMockSocket = () => {
    const socket: any = new EventEmitter();
    socket.readyState = 1; // WebSocket.OPEN
    socket.send = jest.fn();
    socket.close = jest.fn();
    socket.terminate = jest.fn();
    socket.bufferedAmount = 0;
    return socket;
  };

  beforeEach(() => {
    connectionManager = new ConnectionManager();
    roomManager = new RoomManager();

    mockPubSubManager = {
      isConnected: jest.fn().mockReturnValue(true),
      publish: jest.fn().mockResolvedValue(1),
      onMessage: jest.fn()
    };

    dispatcher = new MessageDispatcher({
      connectionManager,
      roomManager,
      redisPubSubManager: mockPubSubManager,
      instanceId: 'pulse-node-1'
    });
  });

  test('suppresses inbound Redis event when originInstanceId matches local instanceId', () => {
    const selfEchoEnvelope: PulseEventEnvelope = {
      eventId: 'evt-001',
      type: 'ROOM_MESSAGE',
      timestamp: Date.now(),
      senderId: 'user-alice',
      target: { roomId: 'ops' },
      payload: { text: 'Self echo frame' },
      originInstanceId: 'pulse-node-1' // Matches local instanceId!
    };

    const handled = dispatcher.handleInboundRedisEvent('pulse:room:ops', selfEchoEnvelope);
    expect(handled).toBe(false); // Suppressed!
  });

  test('allows inbound Redis event when originInstanceId is from a remote node', () => {
    const remoteEnvelope: PulseEventEnvelope = {
      eventId: 'evt-002',
      type: 'ROOM_MESSAGE',
      timestamp: Date.now(),
      senderId: 'user-bob',
      target: { roomId: 'ops' },
      payload: { text: 'Remote message' },
      originInstanceId: 'pulse-node-2' // Remote node!
    };

    const handled = dispatcher.handleInboundRedisEvent('pulse:room:ops', remoteEnvelope);
    expect(handled).toBe(true); // Accepted for delivery!
  });

  test('proves no duplicate local delivery when message echoes back through Redis', () => {
    // Connect Alice (sender) and Bob (recipient) to Pulse Node 1
    const aliceSocket = createMockSocket();
    const bobSocket = createMockSocket();

    const alice = new Connection({
      socket: aliceSocket,
      connectionId: 'conn-alice',
      userId: 'alice'
    });

    const bob = new Connection({
      socket: bobSocket,
      connectionId: 'conn-bob',
      userId: 'bob'
    });

    connectionManager.addConnection(alice);
    connectionManager.addConnection(bob);

    roomManager.joinRoom('engineering', alice.connectionId);
    roomManager.joinRoom('engineering', bob.connectionId);
    alice.joinRoom('engineering');
    bob.joinRoom('engineering');

    // Alice sends ROOM_MESSAGE
    const aliceRawMessage = JSON.stringify({
      eventId: '018f673a-4421-7299-8d18-000000000001',
      type: 'ROOM_MESSAGE',
      target: { roomId: 'engineering' },
      payload: { content: 'Deploying release v1' }
    });

    dispatcher.dispatchRawMessage(alice, aliceRawMessage);

    // Verify Bob received message once from local broadcast
    expect(bobSocket.send).toHaveBeenCalledTimes(1);
    const sentFrame = JSON.parse(bobSocket.send.mock.calls[0][0]);
    expect(sentFrame.payload.content).toBe('Deploying release v1');

    // Verify message was published to Redis with originInstanceId: 'pulse-node-1'
    expect(mockPubSubManager.publish).toHaveBeenCalledTimes(1);
    const publishedChannel = mockPubSubManager.publish.mock.calls[0][0];
    const publishedEnvelope = mockPubSubManager.publish.mock.calls[0][1];

    expect(publishedChannel).toBe('pulse:room:engineering');
    expect(publishedEnvelope.originInstanceId).toBe('pulse-node-1');

    // Simulate Redis echoing the published message back to Pulse Node 1
    const echoSuppressed = dispatcher.handleInboundRedisEvent(
      'pulse:room:engineering',
      publishedEnvelope
    );

    expect(echoSuppressed).toBe(false);

    // Bob must STILL have received exactly 1 message; NO duplicate delivery
    expect(bobSocket.send).toHaveBeenCalledTimes(1);
  });
});
