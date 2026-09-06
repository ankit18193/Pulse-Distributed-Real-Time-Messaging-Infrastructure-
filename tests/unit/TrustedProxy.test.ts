import http from 'http';
import WebSocket from 'ws';
import { PulseServer } from '../../src/core/PulseServer.js';
import { Authenticator } from '../../src/auth/Authenticator.js';
import type { PulseConfig } from '../../src/types/index.js';

describe('Pulse Trusted Proxy Integration Boundary', () => {
  const authSecret = 'test-secret-key-at-least-32-characters-long!';
  let authenticator: Authenticator;

  beforeAll(() => {
    authenticator = new Authenticator(authSecret);
  });

  function createSignedToken(userId: string): string {
    const payload = {
      userId,
      exp: Date.now() + 300000,
      roles: ['user'],
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = require('crypto')
      .createHmac('sha256', authSecret)
      .update(encodedPayload)
      .digest('base64url');
    return `${encodedPayload}.${signature}`;
  }

  it('should ignore X-Forwarded-For when trustProxy is false (default behavior)', async () => {
    const config: PulseConfig = {
      port: 0,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'test-node-1',
      heartbeatIntervalMs: 10000,
      heartbeatTimeoutMs: 20000,
      maxPayloadBytes: 65536,
      authSecret,
      trustProxy: false,
      redisEnabled: false,
      metricsEnabled: false,
    };

    const server = new PulseServer(config);
    await server.start();
    const port = (server as any).httpServer.address().port;

    const token = createSignedToken('usr_direct_client');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, {
      headers: {
        'X-Forwarded-For': '203.0.113.195',
      },
    });

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        const conns = server.getConnectionManager().getAllConnections();
        expect(conns.length).toBe(1);
        const conn = conns[0]!;
        // Must NOT trust XFF; must use immediate TCP remote address
        expect(conn.remoteAddress).not.toBe('203.0.113.195');
        expect(conn.remoteAddress).toBe('127.0.0.1');
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });

    await server.stop();
  });

  it('should trust X-Forwarded-For when trustProxy is true and peer is in trustedProxies', async () => {
    const config: PulseConfig = {
      port: 0,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'test-node-2',
      heartbeatIntervalMs: 10000,
      heartbeatTimeoutMs: 20000,
      maxPayloadBytes: 65536,
      authSecret,
      trustProxy: true,
      trustedProxies: ['127.0.0.1', '::1', '::ffff:127.0.0.1'],
      redisEnabled: false,
      metricsEnabled: false,
    };

    const server = new PulseServer(config);
    await server.start();
    const port = (server as any).httpServer.address().port;

    const token = createSignedToken('usr_trusted_proxy');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, {
      headers: {
        'X-Forwarded-For': '198.51.100.42, 10.0.0.1',
        'X-Request-Id': 'req_test_correlation_123',
      },
    });

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        const conns = server.getConnectionManager().getAllConnections();
        expect(conns.length).toBe(1);
        const conn = conns[0]!;
        // Trusted proxy: first token extracted
        expect(conn.remoteAddress).toBe('198.51.100.42');
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });

    await server.stop();
  });

  it('should reject X-Forwarded-For when trustProxy is true but immediate peer is NOT trusted', async () => {
    const config: PulseConfig = {
      port: 0,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'test-node-3',
      heartbeatIntervalMs: 10000,
      heartbeatTimeoutMs: 20000,
      maxPayloadBytes: 65536,
      authSecret,
      trustProxy: true,
      // Configure an external IP as the ONLY trusted proxy
      trustedProxies: ['192.168.1.100'],
      redisEnabled: false,
      metricsEnabled: false,
    };

    const server = new PulseServer(config);
    await server.start();
    const port = (server as any).httpServer.address().port;

    const token = createSignedToken('usr_untrusted_peer');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, {
      headers: {
        'X-Forwarded-For': '203.0.113.195',
      },
    });

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        const conns = server.getConnectionManager().getAllConnections();
        expect(conns.length).toBe(1);
        const conn = conns[0]!;
        // Immediate peer is 127.0.0.1, which is NOT in ['192.168.1.100'] -> must not trust spoofed XFF
        expect(conn.remoteAddress).toBe('127.0.0.1');
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });

    await server.stop();
  });
});
