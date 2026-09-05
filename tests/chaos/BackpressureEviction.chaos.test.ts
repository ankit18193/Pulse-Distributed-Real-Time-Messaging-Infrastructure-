import WebSocket from 'ws';
import { PulseServer } from '../../src/core/PulseServer.js';
import { loadConfig } from '../../src/config/index.js';
import { Authenticator } from '../../src/auth/Authenticator.js';
import { generateUUIDv7 } from '../../src/utils/uuidv7.js';
import { PulseEventEnvelope } from '../../src/types/index.js';

describe('Chaos Drill: Slow Consumer Backpressure & Eviction', () => {
  const nodePort = 9271;
  const authSecret = 'pulse-backpressure-chaos-secret-32ch';
  const authenticator = new Authenticator(authSecret);

  let server: PulseServer;

  beforeEach(async () => {
    // Start Pulse Server with a deterministic 32 KB bufferedAmount ceiling
    const config = loadConfig({
      port: nodePort,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'pulse-backpressure-node',
      authSecret,
      metricsEnabled: true,
      maxBufferedAmountBytes: 32768 // 32 KB threshold
    });
    server = new PulseServer(config);
    await server.start();
  });

  afterEach(async () => {
    if (server) {
      await server.stop({ gracePeriodMs: 100 });
    }
  });

  test('slow consumer socket pause -> buffer exceeds maxBufferedAmountBytes -> evicted with code 1008 -> metrics increment -> healthy peer continuity', async () => {
    const roomId = 'backpressure-chaos-room';

    const senderToken = authenticator.generateToken({ userId: 'producer-alice' });
    const healthyToken = authenticator.generateToken({ userId: 'healthy-bob' });
    const slowToken = authenticator.generateToken({ userId: 'slow-charlie' });

    // 1. Connect Healthy Consumer Bob
    const healthyWs = new WebSocket(`ws://127.0.0.1:${nodePort}/ws?token=${healthyToken}`);
    let healthyReceivedCount = 0;
    let healthyClosed = false;

    healthyWs.on('message', (d) => {
      try {
        const msg = JSON.parse(d.toString());
        if (msg.type === 'ROOM_MESSAGE') {
          healthyReceivedCount++;
        }
      } catch {}
    });

    healthyWs.on('close', () => {
      healthyClosed = true;
    });

    // 2. Connect Slow Consumer Charlie
    const slowWs = new WebSocket(`ws://127.0.0.1:${nodePort}/ws?token=${slowToken}`);
    let slowClosed = false;
    let slowCloseCode = 0;
    let slowCloseReason = '';

    slowWs.on('close', (code, reason) => {
      slowClosed = true;
      slowCloseCode = code;
      slowCloseReason = reason.toString();
    });

    // 3. Connect Sender Alice
    const senderWs = new WebSocket(`ws://127.0.0.1:${nodePort}/ws?token=${senderToken}`);

    await Promise.all([
      new Promise<void>((res) => healthyWs.on('open', () => res())),
      new Promise<void>((res) => slowWs.on('open', () => res())),
      new Promise<void>((res) => senderWs.on('open', () => res()))
    ]);

    // Join all three to the backpressure room
    for (const ws of [healthyWs, slowWs, senderWs]) {
      ws.send(
        JSON.stringify({
          eventId: generateUUIDv7(),
          type: 'ROOM_JOIN',
          timestamp: Date.now(),
          senderId: 'system',
          target: { roomId },
          payload: { roomId }
        })
      );
    }

    // Allow room membership to propagate
    await new Promise((r) => setTimeout(r, 100));

    // 4. Deliberately pause reading on the slow consumer socket to induce TCP window zero / buffer buildup
    const slowSocket = (slowWs as any)._socket;
    expect(slowSocket).toBeDefined();
    if (slowSocket && typeof slowSocket.pause === 'function') {
      slowSocket.pause();
    }

    // 5. Flood the room with high-volume messages (4KB chunks x 80 messages = ~320 KB traffic)
    // This far exceeds the 32 KB maxBufferedAmountBytes ceiling
    const largeChunk = 'Z'.repeat(4096);
    const totalFrames = 80;

    for (let i = 0; i < totalFrames; i++) {
      if (senderWs.readyState === WebSocket.OPEN) {
        const frame: PulseEventEnvelope = {
          eventId: generateUUIDv7(),
          type: 'ROOM_MESSAGE',
          timestamp: Date.now(),
          senderId: 'producer-alice',
          target: { roomId },
          payload: {
            index: i,
            chunk: largeChunk
          }
        };
        senderWs.send(JSON.stringify(frame));
      }

      if (i % 5 === 0) {
        await new Promise((r) => setTimeout(r, 5));
      }
    }

    // Allow server loop to dispatch messages and encounter buffer threshold breach
    await new Promise((r) => setTimeout(r, 200));

    // Resume reading on slow consumer so it receives the server's RFC 6455 close frame
    if (slowSocket && typeof slowSocket.resume === 'function') {
      slowSocket.resume();
    }

    // Wait for close event on slow consumer
    const deadline = Date.now() + 2000;
    while (!slowClosed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    // =========================================================================
    // STRICT ASSERTIONS
    // =========================================================================
    // 1. Slow consumer MUST be evicted
    expect(slowClosed).toBe(true);

    // 2. Close code MUST be RFC 6455 Code 1008 (Policy Violation)
    expect(slowCloseCode).toBe(1008);
    expect(slowCloseReason).toContain('Policy Violation');

    // 3. Healthy consumer MUST remain connected and operating normally
    expect(healthyClosed).toBe(false);
    expect(healthyWs.readyState).toBe(WebSocket.OPEN);
    expect(healthyReceivedCount).toBeGreaterThan(0);

    // 4. Scrape Prometheus metrics to verify drop counter and closed counter increments
    const metricsRes = await fetch(`http://127.0.0.1:${nodePort}/metrics`);
    const metricsText = await metricsRes.text();

    expect(metricsText).toContain('pulse_messages_dropped_total{reason="slow_consumer"}');
    expect(metricsText).toContain('pulse_connections_closed_total{reason="slow_consumer"}');

    // Cleanup client connections
    healthyWs.close();
    senderWs.close();
    if (slowWs.readyState === WebSocket.OPEN) {
      slowWs.close();
    }
  });
});
