import WebSocket from 'ws';
import { PulseServer } from '../../src/core/PulseServer';
import { loadConfig } from '../../src/config';
import { PulseEventEnvelope } from '../../src/types';

describe('Phase 10 — Production Security Hardening', () => {
  const testPort = 9292;
  const authSecret = 'phase10-security-secret-32-chars-long!';

  describe('Production Config Fail-Safe Validation', () => {
    test('strictly rejects default AUTH_SECRET when NODE_ENV=production', () => {
      expect(() => {
        loadConfig({
          nodeEnv: 'production',
          authSecret: 'pulse-distributed-realtime-secret-key-32chars!'
        });
      }).toThrow(/Production deployment must set a strong, non-default AUTH_SECRET/);
    });

    test('rejects secrets shorter than 32 characters in production', () => {
      expect(() => {
        loadConfig({
          nodeEnv: 'production',
          authSecret: 'short-secret-less-than-32'
        });
      }).toThrow(/must be at least 32 characters long/);
    });

    test('accepts strong custom secret in production', () => {
      const cfg = loadConfig({
        nodeEnv: 'production',
        authSecret: 'custom-prod-secret-min-32-chars-secure-key!'
      });
      expect(cfg.nodeEnv).toBe('production');
      expect(cfg.authSecret).toBe('custom-prod-secret-min-32-chars-secure-key!');
    });
  });

  describe('CSWSH Origin Defense', () => {
    let server: PulseServer;

    beforeEach(async () => {
      server = new PulseServer(
        loadConfig({
          port: testPort,
          host: '127.0.0.1',
          nodeEnv: 'test',
          instanceId: 'pulse-origin-test',
          authSecret,
          allowedOrigins: ['https://pulse.app', 'https://*.pulse.internal'],
          redisEnabled: false
        })
      );
      await server.start();
    });

    afterEach(async () => {
      await server.stop();
    });

    test('rejects connection upgrade from unauthorized origin with HTTP 403', async () => {
      const token = server.getAuthenticator().generateToken({ userId: 'user-cswsh' });
      const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${token}`, {
        headers: { Origin: 'https://attacker.evil.com' }
      });

      const response = await new Promise<{ statusCode?: number }>((resolve) => {
        ws.on('unexpected-response', (_req, res) => {
          resolve({ statusCode: res.statusCode });
        });
        ws.on('open', () => resolve({ statusCode: 101 }));
      });

      expect(response.statusCode).toBe(403);

      const rejectedCounter = server.getMetricsRegistry().getCounter('pulse_connections_rejected_total');
      expect(rejectedCounter?.get({ reason: 'origin_forbidden' })).toBe(1);
    });

    test('accepts connection upgrade from exact allowed origin and wildcard subdomains', async () => {
      const token = server.getAuthenticator().generateToken({ userId: 'user-valid-origin' });

      // 1. Exact match
      const ws1 = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${token}`, {
        headers: { Origin: 'https://pulse.app' }
      });
      await new Promise<void>((res, rej) => {
        ws1.on('open', () => res());
        ws1.on('error', rej);
      });
      expect(ws1.readyState).toBe(WebSocket.OPEN);
      ws1.close();

      // 2. Wildcard subdomain match
      const ws2 = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${token}`, {
        headers: { Origin: 'https://gateway.pulse.internal' }
      });
      await new Promise<void>((res, rej) => {
        ws2.on('open', () => res());
        ws2.on('error', rej);
      });
      expect(ws2.readyState).toBe(WebSocket.OPEN);
      ws2.close();
    });
  });

  describe('WebSocket Inbound Rate Limiting & Abuse Defense', () => {
    let server: PulseServer;

    beforeEach(async () => {
      server = new PulseServer(
        loadConfig({
          port: testPort,
          host: '127.0.0.1',
          nodeEnv: 'test',
          instanceId: 'pulse-rate-limit-test',
          authSecret,
          inboundRateLimitMax: 5,
          inboundRateLimitBurst: 5,
          redisEnabled: false
        })
      );
      await server.start();
    });

    afterEach(async () => {
      await server.stop();
    });

    test('sends protocol SYS_ERROR with RATE_LIMIT_EXCEEDED when token bucket is exhausted', async () => {
      const token = server.getAuthenticator().generateToken({ userId: 'user-rate-limited' });
      const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${token}`);
      const receivedMessages: PulseEventEnvelope[] = [];

      ws.on('message', (data) => {
        try {
          receivedMessages.push(JSON.parse(data.toString()));
        } catch {
          // ignore
        }
      });

      await new Promise<void>((res) => ws.on('open', () => res()));

      // Send 10 rapid messages (limit is 5 burst)
      for (let i = 0; i < 10; i++) {
        ws.send(JSON.stringify({
          eventId: `0191c98a-0000-7000-8000-${String(i).padStart(12, '0')}`,
          type: 'SYS_PING',
          timestamp: Date.now(),
          senderId: 'user-rate-limited',
          payload: {}
        }));
      }

      // Wait for server processing
      await new Promise((r) => setTimeout(r, 200));

      // Must receive SYS_ERROR with code RATE_LIMIT_EXCEEDED
      const rateLimitErrors = receivedMessages.filter(
        (m) => m.type === 'SYS_ERROR' && (m.payload as any)?.code === 'RATE_LIMIT_EXCEEDED'
      );
      expect(rateLimitErrors.length).toBeGreaterThan(0);

      // Verify Prometheus metric incremented
      const rateLimitMetric = server.getMetricsRegistry().getCounter('pulse_rate_limit_exceeded_total');
      expect(rateLimitMetric?.get({ direction: 'inbound' })).toBeGreaterThan(0);

      ws.close();
    });

    test('terminates persistent abusive client with RFC 1008 policy violation', async () => {
      const token = server.getAuthenticator().generateToken({ userId: 'user-abusive' });
      const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${token}`);

      await new Promise<void>((res) => ws.on('open', () => res()));

      const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.on('close', (code, reason) => {
          resolve({ code, reason: reason.toString() });
        });
      });

      // Flood 25 rapid messages to trigger >= 10 violations threshold
      for (let i = 0; i < 25; i++) {
        ws.send(JSON.stringify({
          eventId: `0191c98a-0000-7000-8000-${String(i).padStart(12, '0')}`,
          type: 'SYS_PING',
          timestamp: Date.now(),
          senderId: 'user-abusive',
          payload: {}
        }));
      }

      const closeEvent = await closePromise;
      expect(closeEvent.code).toBe(1008);
      expect(closeEvent.reason).toContain('Rate limit abuse');
    });
  });

  describe('Room Subscription Bounds & Input Sanitation', () => {
    let server: PulseServer;

    beforeEach(async () => {
      server = new PulseServer(
        loadConfig({
          port: testPort,
          host: '127.0.0.1',
          nodeEnv: 'test',
          instanceId: 'pulse-room-bounds-test',
          authSecret,
          maxRoomsPerConnection: 3,
          maxRoomIdLength: 32,
          redisEnabled: false
        })
      );
      await server.start();
    });

    afterEach(async () => {
      await server.stop();
    });

    test('rejects room join with oversized room ID or invalid characters with INVALID_ROOM_ID', async () => {
      const token = server.getAuthenticator().generateToken({ userId: 'user-room-bounds' });
      const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${token}`);
      const receivedMessages: PulseEventEnvelope[] = [];

      ws.on('message', (data) => {
        try {
          receivedMessages.push(JSON.parse(data.toString()));
        } catch {
          // ignore
        }
      });

      await new Promise<void>((res) => ws.on('open', () => res()));

      // 1. Oversized roomId (> 32 chars)
      const longRoom = 'a'.repeat(40);
      ws.send(JSON.stringify({
        eventId: '0191c98a-0000-7000-8000-000000000001',
        type: 'ROOM_JOIN',
        timestamp: Date.now(),
        senderId: 'user-room-bounds',
        target: { roomId: longRoom }
      }));

      // 2. Illegal characters (<script>)
      ws.send(JSON.stringify({
        eventId: '0191c98a-0000-7000-8000-000000000002',
        type: 'ROOM_JOIN',
        timestamp: Date.now(),
        senderId: 'user-room-bounds',
        target: { roomId: 'room<script>alert(1)</script>' }
      }));

      await new Promise((r) => setTimeout(r, 100));

      const invalidRoomErrors = receivedMessages.filter(
        (m) => m.type === 'SYS_ERROR' && (m.payload as any)?.code === 'INVALID_ROOM_ID'
      );
      expect(invalidRoomErrors.length).toBe(2);

      ws.close();
    });

    test('enforces maxRoomsPerConnection and rejects further joins with MAX_ROOMS_EXCEEDED', async () => {
      const token = server.getAuthenticator().generateToken({ userId: 'user-room-cap' });
      const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${token}`);
      const receivedMessages: PulseEventEnvelope[] = [];

      ws.on('message', (data) => {
        try {
          receivedMessages.push(JSON.parse(data.toString()));
        } catch {
          // ignore
        }
      });

      await new Promise<void>((res) => ws.on('open', () => res()));

      // Join 3 rooms (allowed)
      for (let i = 1; i <= 3; i++) {
        ws.send(JSON.stringify({
          eventId: `0191c98a-0000-7000-8000-00000000001${i}`,
          type: 'ROOM_JOIN',
          timestamp: Date.now(),
          senderId: 'user-room-cap',
          target: { roomId: `room-${i}` }
        }));
      }

      await new Promise((r) => setTimeout(r, 100));

      const acks = receivedMessages.filter((m) => m.type === 'ROOM_JOIN_ACK');
      expect(acks.length).toBe(3);

      // Attempt to join 4th room (cap is 3)
      ws.send(JSON.stringify({
        eventId: '0191c98a-0000-7000-8000-000000000014',
        type: 'ROOM_JOIN',
        timestamp: Date.now(),
        senderId: 'user-room-cap',
        target: { roomId: 'room-4' }
      }));

      await new Promise((r) => setTimeout(r, 100));

      const capError = receivedMessages.find(
        (m) => m.type === 'SYS_ERROR' && (m.payload as any)?.code === 'MAX_ROOMS_EXCEEDED'
      );
      expect(capError).toBeDefined();

      ws.close();
    });
  });
});
