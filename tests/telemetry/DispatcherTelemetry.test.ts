import http from 'http';
import { WebSocket } from 'ws';
import { PulseServer } from '../../src/core/PulseServer.js';
import { loadConfig } from '../../src/config/index.js';
import { Authenticator } from '../../src/auth/Authenticator.js';
import { generateUUIDv7 } from '../../src/utils/uuidv7.js';

describe('Checkpoint 09: WebSocket and Message Telemetry Integration', () => {
  const testPort = 9480;
  const authSecret = 'pulse-telemetry-test-secret-32-chars-long!';
  let server: PulseServer;
  let authenticator: Authenticator;

  beforeAll(() => {
    authenticator = new Authenticator(authSecret);
  });

  afterEach(async () => {
    if (server && server.isServerRunning()) {
      await server.stop();
    }
  });

  const fetchMetrics = (port: number = testPort): Promise<string> => {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/metrics',
          method: 'GET',
          agent: false,
          headers: { Connection: 'close' }
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve(data));
        }
      );
      req.on('error', reject);
      req.end();
    });
  };

  const connectClient = (
    token: string,
    port: number = testPort
  ): Promise<{ ws: WebSocket; received: any[] }> => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${token}`);
      const received: any[] = [];

      ws.on('message', (data) => {
        try {
          received.push(JSON.parse(data.toString()));
        } catch {
          received.push(data.toString());
        }
      });

      ws.on('open', () => resolve({ ws, received }));
      ws.on('error', reject);
    });
  };

  it('tracks connection lifecycle: attempts, active gauge, and closures', async () => {
    const config = loadConfig({
      port: testPort,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'test-telemetry-node',
      authSecret,
      redisEnabled: false
    });

    server = new PulseServer(config);
    const registry = server.getMetricsRegistry();
    await server.start();

    // 1. Connection attempt with invalid auth
    await expect(
      connectClient('invalid-token', testPort)
    ).rejects.toThrow();

    const attemptsCounter = registry.getCounter('pulse_connections_total');
    expect(attemptsCounter?.get({ status: 'rejected' })).toBe(1);

    // 2. Successful connection
    const token = authenticator.generateToken({ userId: 'alice', roles: ['user'] });
    const { ws, received } = await connectClient(token, testPort);

    // Wait for SYS_CONNECT_ACK
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].type).toBe('SYS_CONNECT_ACK');

    expect(attemptsCounter?.get({ status: 'success' })).toBe(1);
    const activeGauge = registry.getGauge('pulse_connections_active');
    expect(activeGauge?.get()).toBe(1);

    // 3. Normal close
    await new Promise<void>((resolve) => {
      ws.on('close', () => resolve());
      ws.close(1000, 'Normal client close');
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(activeGauge?.get()).toBe(0);

    const closedCounter = registry.getCounter('pulse_connections_closed_total');
    expect(closedCounter?.get({ reason: 'client_close' })).toBe(1);
  });

  it('tracks room activity, message throughput, delivery ACKs, and latency histograms', async () => {
    const port = 9481;
    const config = loadConfig({
      port,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'test-msg-telemetry-node',
      authSecret,
      redisEnabled: false
    });

    server = new PulseServer(config);
    const registry = server.getMetricsRegistry();
    await server.start();

    const tokenAlice = authenticator.generateToken({ userId: 'alice', roles: ['user'] });
    const tokenBob = authenticator.generateToken({ userId: 'bob', roles: ['user'] });

    const alice = await connectClient(tokenAlice, port);
    const bob = await connectClient(tokenBob, port);

    // Alice joins room 'general'
    const joinMsg = {
      eventId: generateUUIDv7(),
      type: 'ROOM_JOIN',
      timestamp: Date.now(),
      senderId: 'alice',
      target: { roomId: 'general' }
    };
    alice.ws.send(JSON.stringify(joinMsg));

    // Bob joins room 'general'
    const joinMsgBob = {
      eventId: generateUUIDv7(),
      type: 'ROOM_JOIN',
      timestamp: Date.now(),
      senderId: 'bob',
      target: { roomId: 'general' }
    };
    bob.ws.send(JSON.stringify(joinMsgBob));

    await new Promise((resolve) => setTimeout(resolve, 60));

    const roomsGauge = registry.getGauge('pulse_rooms_active');
    expect(roomsGauge?.get()).toBe(1);

    // Alice broadcasts to 'general'
    const roomMsg = {
      eventId: generateUUIDv7(),
      type: 'ROOM_MESSAGE',
      timestamp: Date.now(),
      senderId: 'alice',
      target: { roomId: 'general' },
      payload: { text: 'Hello Bob!' }
    };
    alice.ws.send(JSON.stringify(roomMsg));

    await new Promise((resolve) => setTimeout(resolve, 60));

    // Bob sends a DIRECT_MESSAGE to Alice
    const directMsg = {
      eventId: generateUUIDv7(),
      type: 'DIRECT_MESSAGE',
      timestamp: Date.now(),
      senderId: 'bob',
      target: { recipientId: 'alice' },
      payload: { text: 'Direct reply from Bob' }
    };
    bob.ws.send(JSON.stringify(directMsg));

    await new Promise((resolve) => setTimeout(resolve, 60));

    // Send malformed message from Alice
    alice.ws.send('invalid-non-json-frame{{{');

    await new Promise((resolve) => setTimeout(resolve, 60));

    // Verify counters
    const receivedCounter = registry.getCounter('pulse_messages_received_total');
    expect(receivedCounter?.get({ event_type: 'ROOM_JOIN' })).toBe(2);
    expect(receivedCounter?.get({ event_type: 'ROOM_MESSAGE' })).toBe(1);
    expect(receivedCounter?.get({ event_type: 'DIRECT_MESSAGE' })).toBe(1);
    expect(receivedCounter?.get({ event_type: 'SYS_ERROR' })).toBe(1);

    const droppedCounter = registry.getCounter('pulse_messages_dropped_total');
    expect(droppedCounter?.get({ reason: 'malformed_frame' })).toBe(1);

    const deliveredCounter = registry.getCounter('pulse_messages_delivered_total');
    expect(deliveredCounter?.get({ event_type: 'ROOM_MESSAGE' })).toBeGreaterThanOrEqual(1);
    expect(deliveredCounter?.get({ event_type: 'DIRECT_MESSAGE' })).toBeGreaterThanOrEqual(1);

    const ackCounter = registry.getCounter('pulse_acknowledgements_total');
    expect(ackCounter?.get({ status: 'success' })).toBeGreaterThanOrEqual(4);

    // Verify Histograms
    const procHist = registry.getHistogram('pulse_message_processing_duration_seconds');
    const procVal = procHist?.getValue();
    expect(procVal?.count).toBeGreaterThanOrEqual(4);
    expect(procVal?.sum).toBeGreaterThan(0);

    const delivHist = registry.getHistogram('pulse_local_delivery_duration_seconds');
    const delivVal = delivHist?.getValue();
    expect(delivVal?.count).toBeGreaterThanOrEqual(4);
    expect(delivVal?.sum).toBeGreaterThan(0);

    // Scrape /metrics to verify exposition format
    const metricsOutput = await fetchMetrics(port);
    expect(metricsOutput).toContain('pulse_connections_active 2');
    expect(metricsOutput).toContain('pulse_rooms_active 1');
    expect(metricsOutput).toContain('pulse_messages_received_total{event_type="ROOM_MESSAGE"} 1');
    expect(metricsOutput).toContain('pulse_messages_received_total{event_type="DIRECT_MESSAGE"} 1');
    expect(metricsOutput).toContain('pulse_messages_dropped_total{reason="malformed_frame"} 1');
    expect(metricsOutput).toContain('pulse_message_processing_duration_seconds_count');
    expect(metricsOutput).toContain('pulse_local_delivery_duration_seconds_count');

    alice.ws.close();
    bob.ws.close();
  });

  it('tracks duplicate message drops in idempotency manager', async () => {
    const port = 9482;
    const config = loadConfig({
      port,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'test-dup-telemetry-node',
      authSecret,
      redisEnabled: false
    });

    server = new PulseServer(config);
    const registry = server.getMetricsRegistry();
    await server.start();

    const token = authenticator.generateToken({ userId: 'carol', roles: ['user'] });
    const client = await connectClient(token, port);

    // Carol joins room 'test-room'
    const joinMsg = {
      eventId: generateUUIDv7(),
      type: 'ROOM_JOIN',
      timestamp: Date.now(),
      senderId: 'carol',
      target: { roomId: 'test-room' }
    };
    client.ws.send(JSON.stringify(joinMsg));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Send a message
    const msgId = generateUUIDv7();
    const msg = {
      eventId: msgId,
      type: 'ROOM_MESSAGE',
      timestamp: Date.now(),
      senderId: 'carol',
      target: { roomId: 'test-room' },
      payload: { text: 'First attempt' }
    };
    client.ws.send(JSON.stringify(msg));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Resend exact same message with duplicate eventId
    client.ws.send(JSON.stringify(msg));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const droppedCounter = registry.getCounter('pulse_messages_dropped_total');
    expect(droppedCounter?.get({ reason: 'duplicate' })).toBe(1);

    client.ws.close();
  });
});
