import { RedisConnectionManager } from '../../src/redis/RedisConnectionManager.js';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';

describe('RedisConnectionManager Infrastructure', () => {
  let mockPublisher: any;
  let mockSubscriber: any;

  beforeEach(() => {
    mockPublisher = new RedisMock();
    mockSubscriber = new RedisMock();
  });

  afterEach(async () => {
    if (mockPublisher) mockPublisher.disconnect();
    if (mockSubscriber) mockSubscriber.disconnect();
  });

  test('throws when accessing publisher or subscriber before connect', () => {
    const manager = new RedisConnectionManager({
      host: '127.0.0.1',
      port: 6379
    });

    expect(() => manager.getPublisher()).toThrow('Redis publisher client is not initialized');
    expect(() => manager.getSubscriber()).toThrow('Redis subscriber client is not initialized');
    expect(manager.isConnected()).toBe(false);
  });

  test('establishes dedicated publisher and subscriber connections', async () => {
    const manager = new RedisConnectionManager(
      {
        customClientFactory: (role) => (role === 'publisher' ? mockPublisher : mockSubscriber)
      },
      'pulse-test-node'
    );

    let connectedEventFired = false;
    manager.on('connected', () => {
      connectedEventFired = true;
    });

    await manager.connect();

    expect(manager.isConnected()).toBe(true);
    expect(connectedEventFired).toBe(true);

    const pub = manager.getPublisher();
    const sub = manager.getSubscriber();

    expect(pub).toBe(mockPublisher);
    expect(sub).toBe(mockSubscriber);
    expect(pub).not.toBe(sub);

    const status = manager.getStatus();
    expect(status.publisher).toBe('connected');
    expect(status.subscriber).toBe('connected');
    expect(status.isConnected).toBe(true);

    await manager.disconnect();
    expect(manager.isConnected()).toBe(false);
  });

  test('handles clean shutdown via disconnect()', async () => {
    const manager = new RedisConnectionManager(
      {
        customClientFactory: (role) => (role === 'publisher' ? mockPublisher : mockSubscriber)
      },
      'pulse-test-node'
    );

    await manager.connect();
    expect(manager.isConnected()).toBe(true);

    let disconnectedFired = false;
    manager.on('disconnected', () => {
      disconnectedFired = true;
    });

    await manager.disconnect();

    expect(disconnectedFired).toBe(true);
    expect(manager.isConnected()).toBe(false);
    expect(manager.getStatus().publisher).toBe('disconnected');
    expect(manager.getStatus().subscriber).toBe('disconnected');
  });

  test('handles connection failure during connect()', async () => {
    const failingMock: any = new RedisMock();
    failingMock.status = 'wait';
    failingMock.connect = jest.fn().mockRejectedValue(new Error('Connection refused'));

    const manager = new RedisConnectionManager(
      {
        connectTimeoutMs: 1000,
        customClientFactory: (role) => (role === 'publisher' ? failingMock : mockSubscriber)
      },
      'pulse-test-node'
    );

    await expect(manager.connect()).rejects.toThrow('Connection refused');
    expect(manager.isConnected()).toBe(false);
    expect(manager.getStatus().publisher).toBe('error');
  });

  test('emits error and reconnecting events on client socket events', async () => {
    const manager = new RedisConnectionManager(
      {
        customClientFactory: (role) => (role === 'publisher' ? mockPublisher : mockSubscriber)
      },
      'pulse-test-node'
    );

    await manager.connect();

    const errors: any[] = [];
    manager.on('error', (err) => errors.push(err));

    const testError = new Error('Socket timeout');
    mockPublisher.emit('error', testError);

    expect(errors.length).toBe(1);
    expect(errors[0].role).toBe('publisher');
    expect(errors[0].error.message).toBe('Socket timeout');
    expect(manager.getStatus().publisher).toBe('error');
    expect(manager.isConnected()).toBe(false);

    // Reconnecting event
    const reconnects: any[] = [];
    manager.on('reconnecting', (info) => reconnects.push(info));
    mockPublisher.emit('reconnecting', 500);

    expect(reconnects.length).toBe(1);
    expect(reconnects[0].role).toBe('publisher');
    expect(reconnects[0].delay).toBe(500);
    expect(manager.getStatus().publisher).toBe('reconnecting');

    await manager.disconnect();
  });
});
