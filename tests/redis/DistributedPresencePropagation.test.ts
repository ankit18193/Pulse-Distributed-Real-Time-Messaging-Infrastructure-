import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import { PresenceManager } from '../../src/redis/PresenceManager.js';
import { MessageDispatcher } from '../../src/core/MessageDispatcher.js';
import { ConnectionManager } from '../../src/core/ConnectionManager.js';
import { RoomManager } from '../../src/core/RoomManager.js';
import { RedisPubSubManager, CHANNEL_PRESENCE_EVENTS } from '../../src/redis/RedisPubSubManager.js';
import { RedisConnectionManager } from '../../src/redis/RedisConnectionManager.js';
import { PulseEventEnvelope, PresenceUpdatePayload } from '../../src/types/index.js';

describe('Distributed Presence Event Propagation', () => {
  let sharedRedisPub: any;
  let sharedRedisSub: any;

  let pubSubNodeA: RedisPubSubManager;
  let pubSubNodeB: RedisPubSubManager;

  let presenceNodeA: PresenceManager;
  let presenceNodeB: PresenceManager;

  let dispatcherNodeA: MessageDispatcher;
  let dispatcherNodeB: MessageDispatcher;

  beforeEach(async () => {
    sharedRedisPub = new (RedisMock as any)();

    const connMgrA = new RedisConnectionManager({
      customClientFactory: () => new (RedisMock as any)()
    });
    const connMgrB = new RedisConnectionManager({
      customClientFactory: () => new (RedisMock as any)()
    });

    pubSubNodeA = new RedisPubSubManager(connMgrA, 'node-A');
    pubSubNodeB = new RedisPubSubManager(connMgrB, 'node-B');

    await pubSubNodeA.connect();
    await pubSubNodeB.connect();

    presenceNodeA = new PresenceManager(sharedRedisPub, 'node-A', { pubSubManager: pubSubNodeA });
    presenceNodeB = new PresenceManager(sharedRedisPub, 'node-B', { pubSubManager: pubSubNodeB });

    dispatcherNodeA = new MessageDispatcher({
      connectionManager: new ConnectionManager(),
      roomManager: new RoomManager(),
      redisPubSubManager: pubSubNodeA,
      presenceManager: presenceNodeA,
      instanceId: 'node-A'
    });

    dispatcherNodeB = new MessageDispatcher({
      connectionManager: new ConnectionManager(),
      roomManager: new RoomManager(),
      redisPubSubManager: pubSubNodeB,
      presenceManager: presenceNodeB,
      instanceId: 'node-B'
    });
  });

  afterEach(async () => {
    await pubSubNodeA.disconnect();
    await pubSubNodeB.disconnect();
    await sharedRedisPub.flushall();
  });

  it('publishes PRESENCE_UPDATE on 0 -> 1 transition from Node A and delivers to Node B', async () => {
    const nodeBReceived: PulseEventEnvelope[] = [];
    dispatcherNodeB.onPresenceUpdate((envelope) => {
      nodeBReceived.push(envelope);
    });

    // Mock publishPresence spy on Node A
    const publishSpyA = vi.spyOn(pubSubNodeA, 'publishPresence');

    // Register user Alice on Node A (0 -> 1)
    const result = await presenceNodeA.registerConnection('alice', 'conn-a-1');
    expect(result.isOnlineTransition).toBe(true);
    expect(publishSpyA).toHaveBeenCalledTimes(1);

    const publishedEnvelope: PulseEventEnvelope = publishSpyA.mock.calls[0][0] as any;
    expect(publishedEnvelope.type).toBe('PRESENCE_UPDATE');
    expect(publishedEnvelope.originInstanceId).toBe('node-A');
    expect((publishedEnvelope.payload as PresenceUpdatePayload).userId).toBe('alice');
    expect((publishedEnvelope.payload as PresenceUpdatePayload).status).toBe('ONLINE');

    // Simulate Redis Pub/Sub delivery to Node B
    const processed = dispatcherNodeB.handleInboundRedisEvent(
      CHANNEL_PRESENCE_EVENTS,
      JSON.stringify(publishedEnvelope)
    );
    expect(processed).toBe(true);

    expect(nodeBReceived.length).toBe(1);
    expect(nodeBReceived[0].eventId).toBe(publishedEnvelope.eventId);
    expect((nodeBReceived[0].payload as PresenceUpdatePayload).status).toBe('ONLINE');
  });

  it('suppresses self-echo when event returns to originating node', async () => {
    const nodeAReceived: PulseEventEnvelope[] = [];
    dispatcherNodeA.onPresenceUpdate((envelope) => {
      nodeAReceived.push(envelope);
    });

    const envelope: PulseEventEnvelope = {
      eventId: 'evt-self-1',
      type: 'PRESENCE_UPDATE',
      timestamp: Date.now(),
      senderId: 'system',
      originInstanceId: 'node-A', // Origin matches local node-A
      payload: {
        userId: 'alice',
        status: 'ONLINE',
        activeConnections: 1
      }
    };

    const processed = dispatcherNodeA.handleInboundRedisEvent(
      CHANNEL_PRESENCE_EVENTS,
      JSON.stringify(envelope)
    );
    expect(processed).toBe(false);
    expect(nodeAReceived.length).toBe(0);
  });

  it('does NOT publish presence updates for intermediate transitions (1 -> 2 or 2 -> 1)', async () => {
    const publishSpyA = vi.spyOn(pubSubNodeA, 'publishPresence');

    // 0 -> 1: should publish ONLINE
    await presenceNodeA.registerConnection('bob', 'conn-b-1');
    expect(publishSpyA).toHaveBeenCalledTimes(1);

    // 1 -> 2: multi-device, should NOT publish
    await presenceNodeA.registerConnection('bob', 'conn-b-2');
    expect(publishSpyA).toHaveBeenCalledTimes(1);

    // 2 -> 1: partial disconnect, should NOT publish
    await presenceNodeA.removeConnection('bob', 'conn-b-1');
    expect(publishSpyA).toHaveBeenCalledTimes(1);

    // 1 -> 0: final disconnect, should publish OFFLINE
    await presenceNodeA.removeConnection('bob', 'conn-b-2');
    expect(publishSpyA).toHaveBeenCalledTimes(2);

    const offlineEnvelope: PulseEventEnvelope = publishSpyA.mock.calls[1][0] as any;
    expect((offlineEnvelope.payload as PresenceUpdatePayload).status).toBe('OFFLINE');
  });

  it('drops duplicate presence events via IdempotencyManager on Node B', () => {
    const received: PulseEventEnvelope[] = [];
    dispatcherNodeB.onPresenceUpdate((envelope) => {
      received.push(envelope);
    });

    const envelope: PulseEventEnvelope = {
      eventId: 'evt-dup-1',
      type: 'PRESENCE_UPDATE',
      timestamp: 1000,
      senderId: 'system',
      originInstanceId: 'node-A',
      payload: {
        userId: 'carol',
        status: 'ONLINE',
        activeConnections: 1
      }
    };

    // First arrival
    const first = dispatcherNodeB.handleInboundRedisEvent(
      CHANNEL_PRESENCE_EVENTS,
      JSON.stringify(envelope)
    );
    expect(first).toBe(true);
    expect(received.length).toBe(1);

    // Duplicate arrival
    const second = dispatcherNodeB.handleInboundRedisEvent(
      CHANNEL_PRESENCE_EVENTS,
      JSON.stringify(envelope)
    );
    expect(second).toBe(false);
    expect(received.length).toBe(1);
  });

  it('drops stale presence events with older timestamps on Node B', () => {
    const received: PulseEventEnvelope[] = [];
    dispatcherNodeB.onPresenceUpdate((envelope) => {
      received.push(envelope);
    });

    // Event 1 at timestamp 2000
    const env1: PulseEventEnvelope = {
      eventId: 'evt-ts-2000',
      type: 'PRESENCE_UPDATE',
      timestamp: 2000,
      senderId: 'system',
      originInstanceId: 'node-A',
      payload: { userId: 'dave', status: 'ONLINE', activeConnections: 1 }
    };
    expect(dispatcherNodeB.handleInboundRedisEvent(CHANNEL_PRESENCE_EVENTS, JSON.stringify(env1))).toBe(true);
    expect(received.length).toBe(1);

    // Stale Event 2 at timestamp 1500
    const envStale: PulseEventEnvelope = {
      eventId: 'evt-ts-1500',
      type: 'PRESENCE_UPDATE',
      timestamp: 1500,
      senderId: 'system',
      originInstanceId: 'node-A',
      payload: { userId: 'dave', status: 'OFFLINE', activeConnections: 0 }
    };
    expect(dispatcherNodeB.handleInboundRedisEvent(CHANNEL_PRESENCE_EVENTS, JSON.stringify(envStale))).toBe(false);
    expect(received.length).toBe(1);
  });
});
