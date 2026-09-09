import http from 'http';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { PulseServer, Authenticator, PulseEventEnvelope } from '../../src/index.js';

describe('External Consumer & Distribution Verification', () => {
  const TEST_PORT = 9898;
  const TEST_SECRET = 'pulse-consumer-test-secret-32chars!';
  let server: PulseServer;

  afterEach(async () => {
    if (server && server.isServerRunning()) {
      await server.stop();
    }
  });

  describe('Package Packaging Artifact Verification', () => {
    it('generates a valid, publish-ready npm pack tarball containing only distribution assets', () => {
      // Execute npm pack --dry-run --json
      const packOutput = execSync('npm pack --dry-run --json', {
        encoding: 'utf-8',
        cwd: process.cwd()
      });

      const packInfo = JSON.parse(packOutput);
      expect(Array.isArray(packInfo)).toBe(true);
      expect(packInfo.length).toBeGreaterThan(0);

      const pkg = packInfo[0];
      expect(pkg.name).toBe('@ankit18193/pulse');
      expect(pkg.version).toBe('0.4.0');
      expect(pkg.filename).toBe('ankit18193-pulse-0.4.0.tgz');

      const files: string[] = pkg.files.map((f: { path: string }) => f.path);

      // Must include
      expect(files).toContain('dist/index.js');
      expect(files).toContain('dist/index.d.ts');
      expect(files).toContain('dist/bin/pulse-server.js');
      expect(files).toContain('package.json');
      expect(files).toContain('README.md');
      expect(files).toContain('LICENSE');

      // Must NOT include tests, src, or dashboard
      const forbiddenPrefixes = ['tests/', 'src/', 'dashboard/', '.gstack/', '.agents/'];
      for (const file of files) {
        for (const prefix of forbiddenPrefixes) {
          expect(file.startsWith(prefix)).toBe(false);
        }
      }
    }, 20000);
  });

  describe('External Consumer Application Journey', () => {
    it('runs server, authenticates clients, joins rooms, broadcasts messages, and confirms ACKs', async () => {
      server = new PulseServer({
        port: TEST_PORT,
        authSecret: TEST_SECRET,
        metricsEnabled: true,
        allowedOrigins: ['*']
      });

      await server.start();
      expect(server.isServerRunning()).toBe(true);

      const authenticator = new Authenticator(TEST_SECRET);
      const aliceToken = authenticator.generateToken({ userId: 'alice', roles: ['user'] });
      const bobToken = authenticator.generateToken({ userId: 'bob', roles: ['user'] });

      // Connect Alice and Bob with auth token in handshake URL
      const aliceWs = new WebSocket(`ws://localhost:${TEST_PORT}?token=${aliceToken}`);
      const bobWs = new WebSocket(`ws://localhost:${TEST_PORT}?token=${bobToken}`);

      const aliceMessages: PulseEventEnvelope[] = [];
      const bobMessages: PulseEventEnvelope[] = [];

      aliceWs.on('message', (data) => {
        aliceMessages.push(JSON.parse(data.toString()));
      });

      bobWs.on('message', (data) => {
        bobMessages.push(JSON.parse(data.toString()));
      });

      await Promise.all([
        new Promise<void>((resolve) => aliceWs.on('open', () => resolve())),
        new Promise<void>((resolve) => bobWs.on('open', () => resolve()))
      ]);

      // Wait for SYS_CONNECT_ACK
      await new Promise<void>((resolve) => {
        const check = () => {
          const aliceAck = aliceMessages.some((m) => m.type === 'SYS_CONNECT_ACK');
          const bobAck = bobMessages.some((m) => m.type === 'SYS_CONNECT_ACK');
          if (aliceAck && bobAck) resolve();
          else setTimeout(check, 20);
        };
        check();
      });

      expect(server.getActiveConnectionCount()).toBe(2);

      // 2. Both join room 'developer-room'
      const roomId = 'developer-room';
      aliceWs.send(JSON.stringify({
        eventId: 'join-alice-1',
        type: 'ROOM_JOIN',
        timestamp: Date.now(),
        senderId: 'alice',
        target: { roomId },
        payload: { roomId }
      }));

      bobWs.send(JSON.stringify({
        eventId: 'join-bob-1',
        type: 'ROOM_JOIN',
        timestamp: Date.now(),
        senderId: 'bob',
        target: { roomId },
        payload: { roomId }
      }));

      // Wait for ROOM_JOIN_ACK
      await new Promise<void>((resolve) => {
        const check = () => {
          const aliceJoin = aliceMessages.some((m) => m.type === 'ROOM_JOIN_ACK');
          const bobJoin = bobMessages.some((m) => m.type === 'ROOM_JOIN_ACK');
          if (aliceJoin && bobJoin) resolve();
          else setTimeout(check, 20);
        };
        check();
      });

      expect(server.getActiveRoomCount()).toBeGreaterThanOrEqual(1);

      // 3. Alice sends ROOM_MESSAGE with ackRequired: true
      const messagePayload = { text: 'Hello from third-party application consumer!' };
      aliceWs.send(JSON.stringify({
        eventId: 'msg-alice-101',
        type: 'ROOM_MESSAGE',
        timestamp: Date.now(),
        senderId: 'alice',
        target: { roomId },
        ackRequired: true,
        payload: messagePayload
      }));

      // Wait for Bob to receive the message and Alice to receive DELIVERY_ACK
      await new Promise<void>((resolve) => {
        const check = () => {
          const bobGotMsg = bobMessages.some(
            (m) => m.type === 'ROOM_MESSAGE' && (m.payload as any)?.text === messagePayload.text
          );
          const aliceGotAck = aliceMessages.some(
            (m) => m.type === 'DELIVERY_ACK' && m.correlationId === 'msg-alice-101'
          );
          if (bobGotMsg && aliceGotAck) resolve();
          else setTimeout(check, 20);
        };
        check();
      });

      // 4. Verify HTTP Health & Metrics Endpoints
      const healthData = await new Promise<string>((resolve, reject) => {
        http.get(`http://localhost:${TEST_PORT}/health`, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve(data));
        }).on('error', reject);
      });

      const parsedHealth = JSON.parse(healthData);
      expect(parsedHealth.status).toBe('OK');

      const metricsData = await new Promise<string>((resolve, reject) => {
        http.get(`http://localhost:${TEST_PORT}/metrics`, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve(data));
        }).on('error', reject);
      });

      expect(metricsData).toContain('pulse_connections_total');
      expect(metricsData).toContain('pulse_messages_delivered_total');

      // 5. Clean teardown
      aliceWs.close();
      bobWs.close();

      await server.stop();
      expect(server.isServerRunning()).toBe(false);
      expect(server.getActiveConnectionCount()).toBe(0);
    }, 20000);
  });
});
