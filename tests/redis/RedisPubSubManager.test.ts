import { RedisPubSubManager, CHANNEL_PRESENCE_EVENTS } from '../../src/redis/RedisPubSubManager.js';
import { RedisConnectionManager } from '../../src/redis/RedisConnectionManager.js';
import RedisMock from 'ioredis-mock';

describe('RedisPubSubManager', () => {
  let mockPublisher: any;
  let mockSubscriber: any;
  let connectionManager: RedisConnectionManager;
  let pubSubManager: RedisPubSubManager;

  beforeEach(async () => {
    connectionManager = new RedisConnectionManager({
      customClientFactory: (role) => {
        if (role === 'publisher') {
          mockPublisher = new RedisMock();
          return mockPublisher;
        } else {
          mockSubscriber = new RedisMock();
          return mockSubscriber;
        }
      }
    });

    pubSubManager = new RedisPubSubManager(connectionManager, 'pulse-node-test');
    await pubSubManager.connect();
  });

  afterEach(async () => {
    await pubSubManager.disconnect();
    if (mockPublisher) mockPublisher.disconnect();
    if (mockSubscriber) mockSubscriber.disconnect();
  });

  test('reports connection status correctly', () => {
    expect(pubSubManager.isConnected()).toBe(true);
    expect(pubSubManager.getStatus().isConnected).toBe(true);
    expect(pubSubManager.getSubscribedChannelCount()).toBe(0);
  });

  test('subscribes and tracks active channels', async () => {
    const subSpy = jest.spyOn(mockSubscriber, 'subscribe');

    await pubSubManager.subscribe('pulse:room:dev');
    expect(pubSubManager.getSubscribedChannels()).toEqual(['pulse:room:dev']);
    expect(pubSubManager.getSubscribedChannelCount()).toBe(1);
    expect(subSpy).toHaveBeenCalledWith('pulse:room:dev');

    // Duplicate subscribe should be idempotent
    await pubSubManager.subscribe('pulse:room:dev');
    expect(subSpy).toHaveBeenCalledTimes(1);
  });

  test('unsubscribes and removes from tracking set', async () => {
    const unsubSpy = jest.spyOn(mockSubscriber, 'unsubscribe');

    await pubSubManager.subscribe('pulse:room:dev');
    await pubSubManager.unsubscribe('pulse:room:dev');

    expect(pubSubManager.getSubscribedChannels()).toEqual([]);
    expect(pubSubManager.getSubscribedChannelCount()).toBe(0);
    expect(unsubSpy).toHaveBeenCalledWith('pulse:room:dev');

    // Unsubscribing non-subscribed channel is safe no-op
    await pubSubManager.unsubscribe('pulse:room:unknown');
    expect(unsubSpy).toHaveBeenCalledTimes(1);
  });

  test('publishes payload to Redis channel', async () => {
    const pubSpy = jest.spyOn(mockPublisher, 'publish').mockResolvedValue(2);

    const envelope = {
      eventId: 'evt-123',
      type: 'ROOM_MESSAGE',
      payload: { text: 'Hello distributed world' }
    };

    const recipients = await pubSubManager.publish('pulse:room:dev', envelope);
    expect(recipients).toBe(2);
    expect(pubSpy).toHaveBeenCalledWith('pulse:room:dev', JSON.stringify(envelope));
  });

  test('throws error if publishing while disconnected', async () => {
    await pubSubManager.disconnect();

    await expect(
      pubSubManager.publish('pulse:room:dev', { msg: 'fail' })
    ).rejects.toThrow('Cannot publish to channel "pulse:room:dev": Redis is not connected.');
  });

  test('delivers inbound messages to onMessage handler and emits message event', async () => {
    const receivedMessages: Array<{ channel: string; message: string }> = [];
    let eventReceived = false;

    pubSubManager.onMessage((channel, message) => {
      receivedMessages.push({ channel, message });
    });

    pubSubManager.on('message', (channel, message) => {
      eventReceived = true;
    });

    await pubSubManager.subscribe('pulse:room:general');

    // Simulate inbound message from subscriber
    const payload = JSON.stringify({ eventId: '1', text: 'hi' });
    mockSubscriber.emit('message', 'pulse:room:general', payload);

    expect(receivedMessages.length).toBe(1);
    expect(receivedMessages[0]).toEqual({
      channel: 'pulse:room:general',
      message: payload
    });
    expect(eventReceived).toBe(true);
  });

  test('restores channel subscriptions on reconnect', async () => {
    await pubSubManager.subscribe('pulse:room:one');
    await pubSubManager.subscribe('pulse:room:two');

    const subSpy = jest.spyOn(mockSubscriber, 'subscribe');

    // Trigger connectionManager 'connected' event
    connectionManager.emit('connected');

    // Allow promise to tick
    await new Promise((resolve) => setImmediate(resolve));

    expect(subSpy).toHaveBeenCalledWith('pulse:room:one', 'pulse:room:two');
  });

  test('reconnecting the same manager after disconnect attaches subscriber message listener exactly once', async () => {
    const received: string[] = [];
    pubSubManager.onMessage((channel, message) => {
      received.push(message);
    });

    await pubSubManager.subscribe('pulse:room:test');
    mockSubscriber.emit('message', 'pulse:room:test', 'hello-1');
    expect(received).toEqual(['hello-1']);

    // Disconnect
    await pubSubManager.disconnect();

    // Reconnect the EXACT SAME pubSubManager instance
    await pubSubManager.connect();

    // Get the active subscriber client from connectionManager
    const newSubscriber = connectionManager.getSubscriber();
    await pubSubManager.subscribe('pulse:room:test');

    newSubscriber.emit('message', 'pulse:room:test', 'hello-2');
    expect(received).toEqual(['hello-1', 'hello-2']);
  });

  test('subscribes, unsubscribes, and publishes on cluster presence channel', async () => {
    expect(pubSubManager.isSubscribedToPresence()).toBe(false);

    await pubSubManager.subscribePresence();
    expect(pubSubManager.isSubscribedToPresence()).toBe(true);
    expect(pubSubManager.getSubscribedChannels()).toContain('pulse:presence:events');

    const pubSpy = jest.spyOn(mockPublisher, 'publish').mockResolvedValue(3);
    const presenceEnvelope = {
      eventId: 'evt-pres-1',
      type: 'PRESENCE_UPDATE',
      originInstanceId: 'pulse-node-test',
      payload: { userId: 'alice', status: 'ONLINE', activeConnections: 1 }
    };

    const count = await pubSubManager.publishPresence(presenceEnvelope);
    expect(count).toBe(3);
    expect(pubSpy).toHaveBeenCalledWith('pulse:presence:events', JSON.stringify(presenceEnvelope));

    await pubSubManager.unsubscribePresence();
    expect(pubSubManager.isSubscribedToPresence()).toBe(false);
  });
});
