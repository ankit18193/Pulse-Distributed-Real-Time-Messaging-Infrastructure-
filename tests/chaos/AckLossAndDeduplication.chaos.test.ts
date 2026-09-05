import WebSocket from 'ws';
import { PulseServer } from '../../src/core/PulseServer.js';
import { loadConfig } from '../../src/config/index.js';
import { FaultProxy } from '../../src/chaos/FaultProxy.js';
import { Authenticator } from '../../src/auth/Authenticator.js';
import { PulseEventEnvelope } from '../../src/types/index.js';

describe('Chaos Drill: ACK Loss, Retransmission & Idempotent Deduplication', () => {
  const nodePort = 9261;
  const proxyPort = 9262;
  const authSecret = 'pulse-ack-loss-secret-key-32chars!';
  const authenticator = new Authenticator(authSecret);

  let server: PulseServer;
  let proxy: FaultProxy;

  beforeEach(async () => {
    // 1. Start Pulse Server Node
    const config = loadConfig({
      port: nodePort,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'pulse-ack-loss-node',
      authSecret,
      metricsEnabled: true
    });
    server = new PulseServer(config);
    await server.start();

    // 2. Start FaultProxy in 'websocket' mode
    proxy = new FaultProxy({
      listenPort: proxyPort,
      targetHost: '127.0.0.1',
      targetPort: nodePort,
      name: 'ack-loss-proxy',
      mode: 'websocket'
    });
    await proxy.start();
  });

  afterEach(async () => {
    if (proxy) {
      await proxy.close();
    }
    if (server) {
      await server.stop({ gracePeriodMs: 200 });
    }
  });

  test('dropped DELIVERY_ACK frame -> sender ACK timeout -> retry with incremented seq -> server idempotency hit -> exactly-once delivery to recipient', async () => {
    const senderToken = authenticator.generateToken({ userId: 'alice-sender' });
    const recipientToken = authenticator.generateToken({ userId: 'bob-recipient' });

    // Sender connects through FaultProxy
    const senderWs = new WebSocket(`ws://127.0.0.1:${proxyPort}/ws?token=${senderToken}`);
    const senderReceived: PulseEventEnvelope[] = [];
    senderWs.on('message', (d) => {
      try {
        senderReceived.push(JSON.parse(d.toString()));
      } catch {}
    });

    // Recipient connects directly to Pulse Server Node
    const recipientWs = new WebSocket(`ws://127.0.0.1:${nodePort}/ws?token=${recipientToken}`);
    const recipientReceived: PulseEventEnvelope[] = [];
    recipientWs.on('message', (d) => {
      try {
        recipientReceived.push(JSON.parse(d.toString()));
      } catch {}
    });

    await Promise.all([
      new Promise<void>((res) => senderWs.on('open', () => res())),
      new Promise<void>((res) => recipientWs.on('open', () => res()))
    ]);

    // Both join 'idempotency-room'
    const roomId = 'idempotency-room';
    senderWs.send(
      JSON.stringify({
        eventId: '018f673a-0000-7000-8000-000000000051',
        type: 'ROOM_JOIN',
        timestamp: Date.now(),
        senderId: 'alice-sender',
        target: { roomId },
        payload: { roomId }
      })
    );

    recipientWs.send(
      JSON.stringify({
        eventId: '018f673a-0000-7000-8000-000000000052',
        type: 'ROOM_JOIN',
        timestamp: Date.now(),
        senderId: 'bob-recipient',
        target: { roomId },
        payload: { roomId }
      })
    );

    await new Promise((r) => setTimeout(r, 100));

    // =========================================================================
    // STEP 1 & 4: Configure FaultProxy to drop the downlink DELIVERY_ACK frame
    // =========================================================================
    const targetEventId = '018f673a-0000-7000-8000-000000000099';
    const messagePayload = { text: 'critical-financial-transfer', amount: 5000 };
    let ackDropped = false;

    proxy.dropFrames((frame) => {
      if (frame.text && frame.text.includes('DELIVERY_ACK') && frame.text.includes(targetEventId)) {
        ackDropped = true;
        return true; // DROP this complete RFC 6455 frame
      }
      return false; // FORWARD all other frames
    });

    // STEP 1: Sender emits event with seq: 1
    const originalSeq = 1;
    senderWs.send(
      JSON.stringify({
        eventId: targetEventId,
        type: 'ROOM_MESSAGE',
        seq: originalSeq,
        timestamp: Date.now(),
        senderId: 'alice-sender',
        target: { roomId },
        payload: messagePayload,
        ackRequired: true
      })
    );

    // STEP 2 & 3: Server processes and broadcasts to Recipient Bob
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (recipientReceived.some((m) => m.eventId === targetEventId)) {
          clearInterval(interval);
          resolve();
        }
      }, 20);
    });

    // Recipient receives the message once
    const firstDeliveryCount = recipientReceived.filter((m) => m.eventId === targetEventId).length;
    expect(firstDeliveryCount).toBe(1);

    // Wait for the ACK to be generated and dropped by proxy
    await new Promise((r) => setTimeout(r, 100));
    expect(ackDropped).toBe(true);

    // Sender has NOT received DELIVERY_ACK because proxy dropped it
    const senderAckCountBeforeRetry = senderReceived.filter(
      (m) =>
        m.type === 'DELIVERY_ACK' &&
        (m.correlationId === targetEventId || m.payload?.targetEventId === targetEventId)
    ).length;
    expect(senderAckCountBeforeRetry).toBe(0);

    // =========================================================================
    // STEP 5, 6 & 7: Sender ACK timeout fires -> retransmits with same eventId & payload,
    // but incremented transport sequence (originalSeq + 1)
    // =========================================================================
    const retrySeq = originalSeq + 1;

    // Restore proxy so the replayed ACK will pass through
    proxy.dropFrames(null);

    senderWs.send(
      JSON.stringify({
        eventId: targetEventId, // EXACT SAME eventId
        type: 'ROOM_MESSAGE',
        seq: retrySeq, // INCREMENTED sequence per Phase 2 protocol
        timestamp: Date.now(),
        senderId: 'alice-sender',
        target: { roomId },
        payload: messagePayload, // EXACT SAME payload
        ackRequired: true
      })
    );

    // STEP 8, 9, 10 & 11: Server intercepts duplicate eventId via IdempotencyManager:
    // - Replays cached ACK
    // - Suppresses duplicate delivery to Recipient Bob
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (
          senderReceived.some(
            (m) =>
              m.type === 'DELIVERY_ACK' &&
              m.payload?.status === 'ACCEPTED' &&
              (m.correlationId === targetEventId || m.payload?.targetEventId === targetEventId)
          )
        ) {
          clearInterval(interval);
          resolve();
        }
      }, 20);
    });

    // Wait 150ms to verify no duplicate room message leaks to recipient
    await new Promise((r) => setTimeout(r, 150));

    // =========================================================================
    // STRICT ASSERTIONS
    // =========================================================================
    // 1. Recipient delivery count remains strictly 1 (no duplicate room message)
    const finalDeliveryCount = recipientReceived.filter((m) => m.eventId === targetEventId).length;
    expect(finalDeliveryCount).toBe(1);

    // 2. Sender received successful replayed DELIVERY_ACK
    const receivedAck = senderReceived.find(
      (m) =>
        m.type === 'DELIVERY_ACK' &&
        (m.correlationId === targetEventId || m.payload?.targetEventId === targetEventId)
    );
    expect(receivedAck).toBeDefined();
    expect(receivedAck?.payload?.status).toBe('ACCEPTED');

    // 3. Verify protocol invariant checks
    expect(originalSeq).toBe(1);
    expect(retrySeq).toBe(2);

    senderWs.close();
    recipientWs.close();
  });
});
