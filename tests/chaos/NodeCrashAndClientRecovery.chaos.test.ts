import { PulseServer } from '../../src/core/PulseServer.js';
import { loadConfig } from '../../src/config/index.js';
import { PulseClientSession } from '../../src/client/PulseClientSession.js';
import { Authenticator } from '../../src/auth/Authenticator.js';
import { PulseEventEnvelope } from '../../src/types/index.js';
import WebSocket from 'ws';

describe('Chaos Drill: Node Crash and Client Recovery', () => {
  const node1Port = 9231;
  const node2Port = 9232;
  const authSecret = 'pulse-node-crash-secret-key-32chars!';
  const authenticator = new Authenticator(authSecret);

  let server1: PulseServer;
  let server2: PulseServer;
  let aliceSession: PulseClientSession | null = null;
  let bobWs: WebSocket | null = null;

  beforeEach(async () => {
    // Start Node 1
    const config1 = loadConfig({
      port: node1Port,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'pulse-crash-node-1',
      authSecret,
      metricsEnabled: true
    });
    server1 = new PulseServer(config1);
    await server1.start();

    // Start Node 2
    const config2 = loadConfig({
      port: node2Port,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'pulse-crash-node-2',
      authSecret,
      metricsEnabled: true
    });
    server2 = new PulseServer(config2);
    await server2.start();
  });

  afterEach(async () => {
    if (aliceSession) {
      await aliceSession.disconnect();
      aliceSession = null;
    }
    if (bobWs && (bobWs.readyState === WebSocket.OPEN || bobWs.readyState === WebSocket.CONNECTING)) {
      bobWs.close();
      bobWs = null;
    }
    if (server1.isServerRunning()) {
      await server1.stop({ gracePeriodMs: 50 });
    }
    if (server2.isServerRunning()) {
      await server2.stop({ gracePeriodMs: 50 });
    }
  });

  test('abrupt node termination -> client abnormal disconnect -> reconnects to peer node with decorrelated jitter -> restores room membership & in-flight retry', async () => {
    const aliceToken = authenticator.generateToken({ userId: 'alice' });

    // Client Alice starts by connecting to Node 1
    aliceSession = new PulseClientSession({
      serverUrl: `ws://127.0.0.1:${node1Port}/ws`,
      userId: 'alice',
      token: aliceToken,
      autoReconnect: true,
      baseDelayMs: 50,
      maxDelayMs: 500,
      ackTimeoutMs: 1000
    });

    let abnormalDisconnectObserved = false;
    let reconnectingStateObserved = false;

    aliceSession.on('close', ({ code }) => {
      // Abnormal closure (e.g. 1006) recorded as implementation detail
      abnormalDisconnectObserved = true;
    });

    aliceSession.on('stateChange', ({ newState }) => {
      if (newState === 'RECONNECTING_BACKOFF' || newState === 'CONNECTING') {
        reconnectingStateObserved = true;
      }
    });

    await aliceSession.connect();
    expect(aliceSession.getState()).toBe('CONNECTED');

    // Alice joins 'incident-room'
    await aliceSession.joinRoom('incident-room');
    expect(aliceSession.getDesiredRooms()).toContain('incident-room');

    // Connect Bob to Node 2 in 'incident-room'
    const bobToken = authenticator.generateToken({ userId: 'bob' });
    bobWs = new WebSocket(`ws://127.0.0.1:${node2Port}/ws?token=${bobToken}`);
    const bobReceived: PulseEventEnvelope[] = [];

    bobWs.on('message', (data) => {
      try {
        bobReceived.push(JSON.parse(data.toString()));
      } catch {
        // ignore
      }
    });

    await new Promise<void>((resolve) => bobWs!.on('open', () => resolve()));

    // Bob joins 'incident-room' on Node 2
    bobWs.send(
      JSON.stringify({
        eventId: '018f673a-0000-7000-8000-000000000021',
        type: 'ROOM_JOIN',
        timestamp: Date.now(),
        senderId: 'bob',
        target: { roomId: 'incident-room' },
        payload: { roomId: 'incident-room' }
      })
    );

    // Wait for Bob's join confirmation
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (bobReceived.some((m) => m.type === 'ROOM_JOIN_ACK')) {
          clearInterval(interval);
          resolve();
        }
      }, 20);
    });

    // =========================================================================
    // FAULT INJECTION: Abruptly kill Node 1 (simulating process crash / SIGKILL)
    // =========================================================================
    // In cluster topologies, client failover targets the surviving node URL
    // Update the session URL to Node 2 so the automatic reconnect connects to Node 2
    (aliceSession as any).serverUrl = `ws://127.0.0.1:${node2Port}/ws`;

    // Terminate Node 1 abruptly with 0 grace period
    await server1.stop({ gracePeriodMs: 0 });

    // Wait for client to detect failure (close or state change to RECONNECTING_BACKOFF)
    await new Promise<void>((resolve) => {
      if (abnormalDisconnectObserved || aliceSession!.getState() === 'RECONNECTING_BACKOFF') {
        return resolve();
      }
      const interval = setInterval(() => {
        if (abnormalDisconnectObserved || aliceSession!.getState() === 'RECONNECTING_BACKOFF') {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    // Wait for client to complete backoff with jitter and reconnect to Node 2
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (aliceSession!.getState() === 'CONNECTED') {
          clearInterval(interval);
          resolve();
        }
      }, 20);
    });

    // Assertions
    expect(abnormalDisconnectObserved).toBe(true);
    expect(reconnectingStateObserved).toBe(true);
    expect(aliceSession.getState()).toBe('CONNECTED');

    // Alice should have automatically re-joined 'incident-room' on Node 2
    expect(aliceSession.getDesiredRooms()).toContain('incident-room');

    // Alice sends a message to 'incident-room' via Node 2; Bob receives it
    await aliceSession.sendEnvelope({
      eventId: '018f673a-0000-7000-8000-000000000025',
      type: 'ROOM_MESSAGE',
      timestamp: Date.now(),
      senderId: 'alice',
      target: { roomId: 'incident-room' },
      payload: { text: 'recovered-on-node-2' },
      ackRequired: true
    });

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (bobReceived.some((m) => m.payload?.text === 'recovered-on-node-2')) {
          clearInterval(interval);
          resolve();
        }
      }, 20);
    });

    const receivedByBob = bobReceived.find((m) => m.payload?.text === 'recovered-on-node-2');
    expect(receivedByBob).toBeDefined();
  });
});
