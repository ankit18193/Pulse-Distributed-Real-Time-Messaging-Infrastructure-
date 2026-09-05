import WebSocket from 'ws';
import { PulseServer } from '../../src/core/PulseServer.js';
import { loadConfig } from '../../src/config/index.js';
import { FaultProxy } from '../../src/chaos/FaultProxy.js';
import { ChaosScenarioRunner } from '../../src/chaos/ChaosScenarioRunner.js';
import { PulseEventEnvelope } from '../../src/types/index.js';

describe('Chaos Drill: Redis Outage and Recovery (Real Redis Required)', () => {
  const redisHost = process.env.REDIS_HOST || '127.0.0.1';
  const redisPort = Number(process.env.REDIS_PORT) || 6379;
  const redisProxyPort = 6391;

  const node1Port = 9221;
  const node2Port = 9222;
  const authSecret = 'pulse-redis-chaos-secret-key-32chars!';

  let redisProxy: FaultProxy;
  let server1: PulseServer;
  let server2: PulseServer;

  beforeAll(async () => {
    // 1. Strict real Redis enforcement - NO silent mock fallback
    const isRedisLive = await ChaosScenarioRunner.probeRedis(redisHost, redisPort, 3000);
    if (!isRedisLive) {
      throw new Error(
        `PREREQUISITE_FAILED: Real Redis 7 is required at ${redisHost}:${redisPort} for this chaos scenario. ` +
          `Mock fallback is strictly disabled. Start Redis via 'docker compose up -d redis' before running this test.`
      );
    }

    // 2. Start FaultProxy forwarding to the real Redis port
    redisProxy = new FaultProxy({
      listenPort: redisProxyPort,
      targetHost: redisHost,
      targetPort: redisPort,
      name: 'redis-chaos-proxy',
      mode: 'tcp'
    });
    await redisProxy.start();

    // 3. Start Pulse Node 1 pointing to Redis via the FaultProxy
    const config1 = loadConfig({
      port: node1Port,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'pulse-chaos-node-1',
      authSecret,
      redisEnabled: true,
      redisHost: '127.0.0.1',
      redisPort: redisProxyPort,
      metricsEnabled: true
    });
    server1 = new PulseServer(config1);
    await server1.start();

    // 4. Start Pulse Node 2 pointing to Redis via the FaultProxy
    const config2 = loadConfig({
      port: node2Port,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'pulse-chaos-node-2',
      authSecret,
      redisEnabled: true,
      redisHost: '127.0.0.1',
      redisPort: redisProxyPort,
      metricsEnabled: true
    });
    server2 = new PulseServer(config2);
    await server2.start();

    // Wait 200ms for Redis pub/sub subscriptions to settle
    await new Promise((r) => setTimeout(r, 200));
  }, 15000);

  afterAll(async () => {
    if (server1) {
      await server1.stop({ gracePeriodMs: 500 });
    }
    if (server2) {
      await server2.stop({ gracePeriodMs: 500 });
    }
    if (redisProxy) {
      await redisProxy.close();
    }
  });

  async function connectClient(
    port: number,
    server: PulseServer,
    userId: string
  ): Promise<{
    ws: WebSocket;
    received: PulseEventEnvelope[];
    waitForMessage: (
      predicate: (msg: PulseEventEnvelope) => boolean,
      timeoutMs?: number
    ) => Promise<PulseEventEnvelope>;
    close: () => Promise<void>;
  }> {
    const token = server.getAuthenticator().generateToken({ userId });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const received: PulseEventEnvelope[] = [];

    ws.on('message', (data) => {
      try {
        const envelope = JSON.parse(data.toString());
        received.push(envelope);
      } catch {
        // ignore raw
      }
    });

    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    return {
      ws,
      received,
      waitForMessage: (predicate, timeoutMs = 4000) => {
        return new Promise((resolve, reject) => {
          for (const msg of received) {
            if (predicate(msg)) {
              return resolve(msg);
            }
          }
          const timer = setTimeout(() => {
            reject(new Error(`Timed out waiting for message after ${timeoutMs}ms`));
          }, timeoutMs);

          const listener = (data: Buffer | string) => {
            try {
              const msg = JSON.parse(data.toString());
              if (predicate(msg)) {
                clearTimeout(timer);
                ws.off('message', listener);
                resolve(msg);
              }
            } catch {
              // ignore
            }
          };
          ws.on('message', listener);
        });
      },
      close: async () => {
        return new Promise<void>((resolve) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.once('close', () => resolve());
            ws.close();
          } else {
            resolve();
          }
        });
      }
    };
  }

  test('Redis severance -> local routing continues -> readyz 503 -> recovery restores cross-node pub/sub', async () => {
    // 1. Connect Alice to Node 1 and Bob to Node 2
    const alice = await connectClient(node1Port, server1, 'alice');
    const bob = await connectClient(node2Port, server2, 'bob');
    const charlie = await connectClient(node1Port, server1, 'charlie');

    try {
      // Alice joins 'test-room' on Node 1
      alice.ws.send(
        JSON.stringify({
          eventId: '018f673a-0000-7000-8000-000000000001',
          type: 'ROOM_JOIN',
          timestamp: Date.now(),
          senderId: 'alice',
          target: { roomId: 'test-room' },
          payload: { roomId: 'test-room' }
        })
      );
      await alice.waitForMessage((m) => m.type === 'ROOM_JOIN_ACK');

      // Bob joins 'test-room' on Node 2
      bob.ws.send(
        JSON.stringify({
          eventId: '018f673a-0000-7000-8000-000000000002',
          type: 'ROOM_JOIN',
          timestamp: Date.now(),
          senderId: 'bob',
          target: { roomId: 'test-room' },
          payload: { roomId: 'test-room' }
        })
      );
      await bob.waitForMessage((m) => m.type === 'ROOM_JOIN_ACK');

      // Charlie joins 'test-room' on Node 1 (co-located with Alice)
      charlie.ws.send(
        JSON.stringify({
          eventId: '018f673a-0000-7000-8000-000000000003',
          type: 'ROOM_JOIN',
          timestamp: Date.now(),
          senderId: 'charlie',
          target: { roomId: 'test-room' },
          payload: { roomId: 'test-room' }
        })
      );
      await charlie.waitForMessage((m) => m.type === 'ROOM_JOIN_ACK');

      // Baseline: Alice sends cross-node message, Bob receives it
      alice.ws.send(
        JSON.stringify({
          eventId: '018f673a-0000-7000-8000-000000000004',
          type: 'ROOM_MESSAGE',
          timestamp: Date.now(),
          senderId: 'alice',
          target: { roomId: 'test-room' },
          payload: { content: 'baseline-before-outage' }
        })
      );
      const baselineMsg = await bob.waitForMessage(
        (m) => m.payload?.content === 'baseline-before-outage'
      );
      expect(baselineMsg).toBeDefined();

      // =========================================================================
      // FAULT INJECTION: Sever Redis TCP link abruptly
      // =========================================================================
      const faultStartTimer = ChaosScenarioRunner.startMonotonicTimer();
      redisProxy.sever();

      // Wait 150ms for ioredis disconnect events to propagate
      await new Promise((r) => setTimeout(r, 150));
      const mttdMs = faultStartTimer();

      // Assert 1: Local room messaging on Node 1 continues with delivery ACKs
      alice.ws.send(
        JSON.stringify({
          eventId: '018f673a-0000-7000-8000-000000000005',
          type: 'ROOM_MESSAGE',
          timestamp: Date.now(),
          senderId: 'alice',
          target: { roomId: 'test-room' },
          payload: { content: 'local-msg-during-outage' }
        })
      );
      const localDelivered = await charlie.waitForMessage(
        (m) => m.payload?.content === 'local-msg-during-outage'
      );
      expect(localDelivered).toBeDefined();

      // Assert 2: Observability reflects degradation
      const metrics1 = await ChaosScenarioRunner.scrapeMetrics(node1Port);
      expect(metrics1.get('pulse_redis_connection_state')).toBe(0);

      // Verify healthz endpoint is 200 DEGRADED
      const healthRes = await fetch(`http://127.0.0.1:${node1Port}/healthz`);
      const healthData = await healthRes.json();
      expect(healthRes.status).toBe(200);
      expect(healthData.status).toBe('DEGRADED');

      // Verify readyz endpoint drops to 503 NOT_READY
      const readyRes = await fetch(`http://127.0.0.1:${node1Port}/readyz`);
      expect(readyRes.status).toBe(503);

      // =========================================================================
      // RESTORATION: Restore Redis TCP link
      // =========================================================================
      const restoreStartTimer = ChaosScenarioRunner.startMonotonicTimer();
      redisProxy.restore();

      // Poll until readyz recovers to 200 OK (bounded recovery)
      let recovered = false;
      const pollStart = Date.now();
      while (Date.now() - pollStart < 8000) {
        try {
          const res = await fetch(`http://127.0.0.1:${node1Port}/readyz`);
          if (res.status === 200) {
            recovered = true;
            break;
          }
        } catch {
          // keep polling
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      const mttrMs = restoreStartTimer();
      expect(recovered).toBe(true);

      // Assert 3: Cross-node message routing resumes
      alice.ws.send(
        JSON.stringify({
          eventId: '018f673a-0000-7000-8000-000000000006',
          type: 'ROOM_MESSAGE',
          timestamp: Date.now(),
          senderId: 'alice',
          target: { roomId: 'test-room' },
          payload: { content: 'cross-node-after-recovery' }
        })
      );

      const recoveredMsg = await bob.waitForMessage(
        (m) => m.payload?.content === 'cross-node-after-recovery'
      );
      expect(recoveredMsg).toBeDefined();

      // Verify metrics reflect recovery
      const metricsAfter = await ChaosScenarioRunner.scrapeMetrics(node1Port);
      expect(metricsAfter.get('pulse_redis_connection_state')).toBe(1);

      // Verify timing metrics are positive and bounded
      expect(mttdMs).toBeGreaterThan(0);
      expect(mttrMs).toBeGreaterThan(0);
      expect(mttrMs).toBeLessThan(8000); // Generous tolerance for CI/Windows
    } finally {
      await alice.close();
      await bob.close();
      await charlie.close();
    }
  }, 25000);
});
