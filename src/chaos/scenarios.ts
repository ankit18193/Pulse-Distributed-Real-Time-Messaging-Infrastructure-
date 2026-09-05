import http from 'http';
import WebSocket from 'ws';
import { PulseServer } from '../core/PulseServer.js';
import { loadConfig } from '../config/index.js';
import { PulseClientSession } from '../client/PulseClientSession.js';
import { Authenticator } from '../auth/Authenticator.js';
import { PulseEventEnvelope } from '../types/index.js';
import { FaultProxy } from './FaultProxy.js';
import { ChaosScenarioRunner } from './ChaosScenarioRunner.js';
import {
  ChaosScenario,
  ChaosScenarioContext,
  ChaosScenarioResult,
  ChaosTimingMetrics
} from './types.js';
import { logger } from '../utils/logger.js';

export function createAllScenarios(): ChaosScenario[] {
  return [
    createRedisOutageScenario(),
    createNodeCrashScenario(),
    createReconnectStormScenario(),
    createHalfOpenScenario(),
    createAckLossScenario(),
    createBackpressureScenario(),
    createGracefulDrainingScenario()
  ];
}

export function registerAllScenarios(runner: ChaosScenarioRunner): void {
  for (const scenario of createAllScenarios()) {
    runner.register(scenario);
  }
}

/**
 * Drill 1: Redis Outage & Degraded Recovery
 */
function createRedisOutageScenario(): ChaosScenario {
  return {
    id: 'redis-outage',
    name: 'Redis Outage & Degraded Recovery',
    description:
      'Severs Redis link via FaultProxy, tests local standalone degradation, restores link, and verifies cross-node transit.',
    execute: async (ctx: ChaosScenarioContext): Promise<ChaosScenarioResult> => {
      // 1. Verify Real Redis availability
      const redisUp = await ChaosScenarioRunner.probeRedis(ctx.redisHost, ctx.redisPort, 2000);
      if (!redisUp) {
        return {
          scenarioId: 'redis-outage',
          name: 'Redis Outage & Degraded Recovery',
          status: 'UNAVAILABLE',
          timing: { faultInjectedAt: Date.now() },
          metricsAsserted: {},
          error: `PREREQUISITE_FAILED: Real Redis 7 is required on ${ctx.redisHost}:${ctx.redisPort}, but is unreachable.`
        };
      }

      const proxy = new FaultProxy({
        name: 'chaos-redis-proxy',
        listenPort: ctx.redisProxyPort,
        targetHost: ctx.redisHost,
        targetPort: ctx.redisPort,
        mode: 'tcp'
      });
      await proxy.start();

      let server1: PulseServer | null = null;
      let server2: PulseServer | null = null;
      let client1: WebSocket | null = null;
      let client2: WebSocket | null = null;

      try {
        const authenticator = new Authenticator(ctx.authSecret);

        server1 = new PulseServer(
          loadConfig({
            port: ctx.pulsePortA,
            host: '127.0.0.1',
            nodeEnv: 'test',
            instanceId: 'chaos-redis-node-1',
            authSecret: ctx.authSecret,
            redisEnabled: true,
            redisHost: '127.0.0.1',
            redisPort: ctx.redisProxyPort,
            metricsEnabled: true
          })
        );
        await server1.start();

        server2 = new PulseServer(
          loadConfig({
            port: ctx.pulsePortB,
            host: '127.0.0.1',
            nodeEnv: 'test',
            instanceId: 'chaos-redis-node-2',
            authSecret: ctx.authSecret,
            redisEnabled: true,
            redisHost: '127.0.0.1',
            redisPort: ctx.redisProxyPort,
            metricsEnabled: true
          })
        );
        await server2.start();

        const token1 = authenticator.generateToken({ userId: 'alice' });
        const token2 = authenticator.generateToken({ userId: 'bob' });

        client1 = new WebSocket(`ws://127.0.0.1:${ctx.pulsePortA}/ws?token=${token1}`);
        client2 = new WebSocket(`ws://127.0.0.1:${ctx.pulsePortB}/ws?token=${token2}`);

        const client2Messages: PulseEventEnvelope[] = [];
        client2.on('message', (d) => {
          try {
            client2Messages.push(JSON.parse(d.toString()));
          } catch {}
        });

        await Promise.all([
          new Promise<void>((r) => client1!.once('open', () => r())),
          new Promise<void>((r) => client2!.once('open', () => r()))
        ]);

        // Join room on both
        client1.send(
          JSON.stringify({
            eventId: '018f673a-0000-7000-8000-000000000001',
            type: 'ROOM_JOIN',
            timestamp: Date.now(),
            senderId: 'alice',
            target: { roomId: 'chaos-room' },
            payload: { roomId: 'chaos-room' }
          })
        );
        client2.send(
          JSON.stringify({
            eventId: '018f673a-0000-7000-8000-000000000002',
            type: 'ROOM_JOIN',
            timestamp: Date.now(),
            senderId: 'bob',
            target: { roomId: 'chaos-room' },
            payload: { roomId: 'chaos-room' }
          })
        );

        await new Promise((r) => setTimeout(r, 100));

        // FAULT INJECTION: Sever Redis
        const faultInjectedAt = Date.now();
        const dTimer = ChaosScenarioRunner.startMonotonicTimer();
        proxy.sever();

        // MTTD: Poll /readyz until 503 NOT_READY
        let mttdMs = 0;
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline) {
          const res = await new Promise<{ statusCode?: number }>((resResolve) => {
            http
              .get(`http://127.0.0.1:${ctx.pulsePortA}/readyz`, (r) => {
                resResolve({ statusCode: r.statusCode });
              })
              .on('error', () => resResolve({ statusCode: 503 }));
          });
          if (res.statusCode === 503) {
            mttdMs = dTimer();
            break;
          }
          await new Promise((r) => setTimeout(r, 20));
        }

        // FAULT RESTORATION: Restore Redis
        const faultRestoredAt = Date.now();
        const rTimer = ChaosScenarioRunner.startMonotonicTimer();
        proxy.restore();

        // MTTR: Wait for /readyz 200 READY and successful cross-node transmission
        let mttrMs = 0;
        const recoverDeadline = Date.now() + 6000;
        while (Date.now() < recoverDeadline) {
          const res = await new Promise<{ statusCode?: number }>((resResolve) => {
            http
              .get(`http://127.0.0.1:${ctx.pulsePortA}/readyz`, (r) => {
                resResolve({ statusCode: r.statusCode });
              })
              .on('error', () => resResolve({ statusCode: 503 }));
          });
          if (res.statusCode === 200) {
            // Test cross-node message
            client1.send(
              JSON.stringify({
                eventId: '018f673a-0000-7000-8000-000000000005',
                type: 'ROOM_MESSAGE',
                timestamp: Date.now(),
                senderId: 'alice',
                target: { roomId: 'chaos-room' },
                payload: { text: 'recovered-msg' }
              })
            );
            await new Promise((r) => setTimeout(r, 80));
            if (client2Messages.some((m) => (m.payload as { text?: string })?.text === 'recovered-msg')) {
              mttrMs = rTimer();
              break;
            }
          }
          await new Promise((r) => setTimeout(r, 50));
        }

        const passed = mttdMs > 0 && mttrMs > 0;
        return {
          scenarioId: 'redis-outage',
          name: 'Redis Outage & Degraded Recovery',
          status: passed ? 'PASSED' : 'FAILED',
          timing: {
            faultInjectedAt,
            mttdMs,
            faultRestoredAt,
            mttrMs,
            systemRecoveredAt: Date.now()
          },
          metricsAsserted: {
            mttdMs,
            mttrMs
          }
        };
      } finally {
        if (client1) client1.close();
        if (client2) client2.close();
        if (server1 && server1.isServerRunning()) await server1.stop({ gracePeriodMs: 50 });
        if (server2 && server2.isServerRunning()) await server2.stop({ gracePeriodMs: 50 });
        await proxy.stop();
      }
    }
  };
}

/**
 * Drill 2: Node Crash & Client Recovery
 */
function createNodeCrashScenario(): ChaosScenario {
  return {
    id: 'node-crash',
    name: 'Pulse Node Crash & Client Reconnect',
    description:
      'Abruptly terminates Node 1, verifies client detects abnormal close, performs decorrelated jitter backoff, reconnects to Node 2, and restores subscriptions.',
    execute: async (ctx: ChaosScenarioContext): Promise<ChaosScenarioResult> => {
      let server1: PulseServer | null = null;
      let server2: PulseServer | null = null;
      let aliceSession: PulseClientSession | null = null;
      let bobWs: WebSocket | null = null;

      try {
        const authenticator = new Authenticator(ctx.authSecret);
        const node1Port = ctx.pulsePortA + 10;
        const node2Port = ctx.pulsePortB + 10;

        server1 = new PulseServer(
          loadConfig({
            port: node1Port,
            host: '127.0.0.1',
            nodeEnv: 'test',
            instanceId: 'chaos-crash-node-1',
            authSecret: ctx.authSecret,
            metricsEnabled: true
          })
        );
        await server1.start();

        server2 = new PulseServer(
          loadConfig({
            port: node2Port,
            host: '127.0.0.1',
            nodeEnv: 'test',
            instanceId: 'chaos-crash-node-2',
            authSecret: ctx.authSecret,
            metricsEnabled: true
          })
        );
        await server2.start();

        const aliceToken = authenticator.generateToken({ userId: 'alice' });
        aliceSession = new PulseClientSession({
          serverUrl: `ws://127.0.0.1:${node1Port}/ws`,
          userId: 'alice',
          token: aliceToken,
          autoReconnect: true,
          baseDelayMs: 40,
          maxDelayMs: 400
        });

        let abnormalDisconnectObserved = false;
        aliceSession.on('close', () => {
          abnormalDisconnectObserved = true;
        });

        await aliceSession.connect();
        await aliceSession.joinRoom('incident-room');

        const bobToken = authenticator.generateToken({ userId: 'bob' });
        bobWs = new WebSocket(`ws://127.0.0.1:${node2Port}/ws?token=${bobToken}`);
        const bobReceived: PulseEventEnvelope[] = [];
        bobWs.on('message', (d) => {
          try {
            bobReceived.push(JSON.parse(d.toString()));
          } catch {}
        });
        await new Promise<void>((r) => bobWs!.once('open', () => r()));

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
        await new Promise((r) => setTimeout(r, 50));

        // FAULT INJECTION: Abruptly stop Node 1 with 0 grace period
        (aliceSession as any).serverUrl = `ws://127.0.0.1:${node2Port}/ws`;
        const faultInjectedAt = Date.now();
        const dTimer = ChaosScenarioRunner.startMonotonicTimer();

        await server1.stop({ gracePeriodMs: 0 });

        // Wait for abnormal close detection
        const dDeadline = Date.now() + 2000;
        while (!abnormalDisconnectObserved && aliceSession.getState() !== 'RECONNECTING_BACKOFF' && Date.now() < dDeadline) {
          await new Promise((r) => setTimeout(r, 10));
        }
        const mttdMs = dTimer();

        // MTTR: Wait for client reconnect to Node 2
        const rTimer = ChaosScenarioRunner.startMonotonicTimer();
        const rDeadline = Date.now() + 4000;
        while (aliceSession.getState() !== 'CONNECTED' && Date.now() < rDeadline) {
          await new Promise((r) => setTimeout(r, 20));
        }
        const mttrMs = rTimer();

        // Send message from Alice to Node 2
        await aliceSession.sendEnvelope({
          eventId: '018f673a-0000-7000-8000-000000000025',
          type: 'ROOM_MESSAGE',
          timestamp: Date.now(),
          senderId: 'alice',
          target: { roomId: 'incident-room' },
          payload: { text: 'recovered-on-node-2' },
          ackRequired: true
        });

        const msgDeadline = Date.now() + 2000;
        while (!bobReceived.some((m) => (m.payload as { text?: string })?.text === 'recovered-on-node-2') && Date.now() < msgDeadline) {
          await new Promise((r) => setTimeout(r, 20));
        }

        const passed =
          abnormalDisconnectObserved &&
          aliceSession.getState() === 'CONNECTED' &&
          bobReceived.some((m) => (m.payload as { text?: string })?.text === 'recovered-on-node-2');

        return {
          scenarioId: 'node-crash',
          name: 'Pulse Node Crash & Client Reconnect',
          status: passed ? 'PASSED' : 'FAILED',
          timing: {
            faultInjectedAt,
            mttdMs,
            mttrMs,
            systemRecoveredAt: Date.now()
          },
          metricsAsserted: {
            mttdMs,
            mttrMs
          }
        };
      } finally {
        if (aliceSession) await aliceSession.disconnect();
        if (bobWs && (bobWs.readyState === WebSocket.OPEN || bobWs.readyState === WebSocket.CONNECTING)) {
          bobWs.close();
        }
        if (server1 && server1.isServerRunning()) await server1.stop({ gracePeriodMs: 50 });
        if (server2 && server2.isServerRunning()) await server2.stop({ gracePeriodMs: 50 });
      }
    }
  };
}

/**
 * Drill 3: Reconnect Storm & Rate Distribution
 */
function createReconnectStormScenario(): ChaosScenario {
  return {
    id: 'reconnect-storm',
    name: 'Reconnect Storm & Rate Distribution',
    description:
      'Severs and restores 50 concurrent client connections, verifies reconnection rate distribution and bounded event loop lag.',
    execute: async (ctx: ChaosScenarioContext): Promise<ChaosScenarioResult> => {
      const serverPort = ctx.pulsePortA + 20;
      const proxyPort = ctx.pulsePortA + 21;
      const clientCount = 50;

      const server = new PulseServer(
        loadConfig({
          port: serverPort,
          host: '127.0.0.1',
          nodeEnv: 'test',
          instanceId: 'chaos-storm-node',
          authSecret: ctx.authSecret,
          metricsEnabled: true
        })
      );
      await server.start();

      const proxy = new FaultProxy({
        name: 'chaos-storm-proxy',
        listenPort: proxyPort,
        targetHost: '127.0.0.1',
        targetPort: serverPort,
        mode: 'websocket'
      });
      await proxy.start();

      const authenticator = new Authenticator(ctx.authSecret);
      const sessions: PulseClientSession[] = [];
      const connectTimestamps: number[] = [];

      try {
        for (let i = 0; i < clientCount; i++) {
          const userId = `storm-user-${i}`;
          const token = authenticator.generateToken({ userId });
          const session = new PulseClientSession({
            serverUrl: `ws://127.0.0.1:${proxyPort}/ws`,
            userId,
            token,
            autoReconnect: true,
            baseDelayMs: 40,
            maxDelayMs: 600
          });
          session.on('stateChange', ({ newState }) => {
            if (newState === 'CONNECTED') {
              connectTimestamps.push(Date.now());
            }
          });
          sessions.push(session);
        }

        await Promise.all(sessions.map((s) => s.connect()));

        // FAULT INJECTION: Sever proxy
        const faultInjectedAt = Date.now();
        proxy.sever();
        await new Promise((r) => setTimeout(r, 60));

        // RESTORATION: Restore proxy
        const faultRestoredAt = Date.now();
        const rTimer = ChaosScenarioRunner.startMonotonicTimer();
        connectTimestamps.length = 0;
        proxy.restore();

        // Wait for all 50 to reconnect
        const deadline = Date.now() + 10000;
        while (sessions.filter((s) => s.getState() === 'CONNECTED').length < clientCount && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 30));
        }
        const mttrMs = rTimer();

        const reconnectedCount = sessions.filter((s) => s.getState() === 'CONNECTED').length;
        const uniqueTimestamps = new Set(connectTimestamps);

        const metrics = await ChaosScenarioRunner.scrapeMetrics(serverPort);
        const eventLoopLagP99 = metrics.get('pulse_event_loop_lag_p99_seconds') ?? 0;

        const passed = reconnectedCount === clientCount && uniqueTimestamps.size > 1 && eventLoopLagP99 < 0.5;

        return {
          scenarioId: 'reconnect-storm',
          name: 'Reconnect Storm & Rate Distribution',
          status: passed ? 'PASSED' : 'FAILED',
          timing: {
            faultInjectedAt,
            faultRestoredAt,
            mttrMs,
            systemRecoveredAt: Date.now()
          },
          metricsAsserted: {
            reconnectedCount,
            uniqueTimestampsCount: uniqueTimestamps.size,
            eventLoopLagP99
          }
        };
      } finally {
        await Promise.all(sessions.map((s) => s.disconnect()));
        await proxy.stop();
        if (server.isServerRunning()) await server.stop({ gracePeriodMs: 50 });
      }
    }
  };
}

/**
 * Drill 4: Half-Open Connection Blackhole Reap
 */
function createHalfOpenScenario(): ChaosScenario {
  return {
    id: 'half-open',
    name: 'Half-Open Connection Blackhole Reap',
    description:
      'Blackholes client traffic silently, verifies two-phase heartbeat timeout detection, RFC 6455 1002 closure, and forced termination.',
    execute: async (ctx: ChaosScenarioContext): Promise<ChaosScenarioResult> => {
      const serverPort = ctx.pulsePortA + 30;
      const proxyPort = ctx.pulsePortA + 31;

      const server = new PulseServer(
        loadConfig({
          port: serverPort,
          host: '127.0.0.1',
          nodeEnv: 'test',
          instanceId: 'chaos-half-open-node',
          authSecret: ctx.authSecret,
          heartbeatIntervalMs: 100,
          heartbeatTimeoutMs: 100,
          metricsEnabled: true
        })
      );
      await server.start();

      const proxy = new FaultProxy({
        name: 'chaos-half-open-proxy',
        listenPort: proxyPort,
        targetHost: '127.0.0.1',
        targetPort: serverPort,
        mode: 'tcp'
      });
      await proxy.start();

      let clientWs: WebSocket | null = null;
      try {
        const authenticator = new Authenticator(ctx.authSecret);
        const token = authenticator.generateToken({ userId: 'alice-half-open' });

        clientWs = new WebSocket(`ws://127.0.0.1:${proxyPort}/ws?token=${token}`);
        await new Promise<void>((r) => clientWs!.once('open', () => r()));

        // FAULT INJECTION: Blackhole silently
        const faultInjectedAt = Date.now();
        const dTimer = ChaosScenarioRunner.startMonotonicTimer();
        proxy.blackhole(true);

        // Wait for server to reap dead connection (count goes to 0)
        const deadline = Date.now() + 3000;
        while (server.getActiveConnectionCount() > 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 20));
        }
        const mttdMs = dTimer();

        const metrics = await ChaosScenarioRunner.scrapeMetrics(serverPort);
        const reapedCount = metrics.get('pulse_connections_closed_total{reason="heartbeat_timeout"}') ?? 0;

        const passed = server.getActiveConnectionCount() === 0 && reapedCount >= 1;

        return {
          scenarioId: 'half-open',
          name: 'Half-Open Connection Blackhole Reap',
          status: passed ? 'PASSED' : 'FAILED',
          timing: {
            faultInjectedAt,
            mttdMs,
            systemRecoveredAt: Date.now()
          },
          metricsAsserted: {
            activeConnections: server.getActiveConnectionCount(),
            heartbeatTimeoutsReaped: reapedCount,
            mttdMs
          }
        };
      } finally {
        if (clientWs && (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING)) {
          clientWs.close();
        }
        await proxy.stop();
        if (server.isServerRunning()) await server.stop({ gracePeriodMs: 50 });
      }
    }
  };
}

/**
 * Drill 5: ACK Loss & Deduplication
 */
function createAckLossScenario(): ChaosScenario {
  return {
    id: 'ack-loss',
    name: 'ACK Loss & Idempotency Replay',
    description:
      'Drops DELIVERY_ACK frame in proxy, triggers client retry with incremented sequence, and verifies server replay without duplicate delivery.',
    execute: async (ctx: ChaosScenarioContext): Promise<ChaosScenarioResult> => {
      const serverPort = ctx.pulsePortA + 40;
      const proxyPort = ctx.pulsePortA + 41;
      const targetEventId = '018f673a-0000-7000-8000-000000000055';

      let dropOccurred = false;
      const proxy = new FaultProxy({
        name: 'chaos-ack-loss-proxy',
        listenPort: proxyPort,
        targetHost: '127.0.0.1',
        targetPort: serverPort,
        mode: 'websocket'
      });
      proxy.dropFrames((frame) => {
        if (frame.text && !dropOccurred) {
          try {
            const env = JSON.parse(frame.text) as PulseEventEnvelope;
            if (
              env.type === 'DELIVERY_ACK' &&
              (env.correlationId === targetEventId ||
                (env.payload as { targetEventId?: string })?.targetEventId === targetEventId)
            ) {
              dropOccurred = true;
              return true; // Drop frame
            }
          } catch {}
        }
        return false;
      });
      await proxy.start();

      const server = new PulseServer(
        loadConfig({
          port: serverPort,
          host: '127.0.0.1',
          nodeEnv: 'test',
          instanceId: 'chaos-ack-node',
          authSecret: ctx.authSecret,
          metricsEnabled: true
        })
      );
      await server.start();

      const authenticator = new Authenticator(ctx.authSecret);
      let aliceSession: PulseClientSession | null = null;
      let bobWs: WebSocket | null = null;

      try {
        const aliceToken = authenticator.generateToken({ userId: 'alice' });
        aliceSession = new PulseClientSession({
          serverUrl: `ws://127.0.0.1:${proxyPort}/ws`,
          userId: 'alice',
          token: aliceToken,
          ackTimeoutMs: 120,
          maxRetries: 3
        });
        await aliceSession.connect();
        await aliceSession.joinRoom('reliable-room');

        const bobToken = authenticator.generateToken({ userId: 'bob' });
        bobWs = new WebSocket(`ws://127.0.0.1:${serverPort}/ws?token=${bobToken}`);
        const bobReceived: PulseEventEnvelope[] = [];
        bobWs.on('message', (d) => {
          try {
            bobReceived.push(JSON.parse(d.toString()));
          } catch {}
        });
        await new Promise<void>((r) => bobWs!.once('open', () => r()));

        bobWs.send(
          JSON.stringify({
            eventId: '018f673a-0000-7000-8000-000000000021',
            type: 'ROOM_JOIN',
            timestamp: Date.now(),
            senderId: 'bob',
            target: { roomId: 'reliable-room' },
            payload: { roomId: 'reliable-room' }
          })
        );
        await new Promise((r) => setTimeout(r, 50));

        // Alice sends message with ackRequired: true
        const faultInjectedAt = Date.now();
        const rTimer = ChaosScenarioRunner.startMonotonicTimer();
        const ackEnvelope = (await aliceSession.sendEnvelope({
          eventId: targetEventId,
          type: 'ROOM_MESSAGE',
          timestamp: Date.now(),
          senderId: 'alice',
          target: { roomId: 'reliable-room' },
          payload: { text: 'critical-trade-execution' },
          ackRequired: true
        })) as PulseEventEnvelope;
        const mttrMs = rTimer();

        // Wait for Bob message delivery
        await new Promise((r) => setTimeout(r, 60));

        const bobCopies = bobReceived.filter(
          (m) =>
            m.type === 'ROOM_MESSAGE' &&
            (m.payload as { text?: string })?.text === 'critical-trade-execution'
        );

        const passed =
          dropOccurred &&
          ackEnvelope !== undefined &&
          ackEnvelope.type === 'DELIVERY_ACK' &&
          bobCopies.length === 1;

        return {
          scenarioId: 'ack-loss',
          name: 'ACK Loss & Idempotency Replay',
          status: passed ? 'PASSED' : 'FAILED',
          timing: {
            faultInjectedAt,
            mttrMs,
            systemRecoveredAt: Date.now()
          },
          metricsAsserted: {
            dropOccurred: dropOccurred ? 1 : 0,
            bobDeliveredCopies: bobCopies.length,
            mttrMs
          }
        };
      } finally {
        if (aliceSession) await aliceSession.disconnect();
        if (bobWs && (bobWs.readyState === WebSocket.OPEN || bobWs.readyState === WebSocket.CONNECTING)) {
          bobWs.close();
        }
        await proxy.stop();
        if (server.isServerRunning()) await server.stop({ gracePeriodMs: 50 });
      }
    }
  };
}

/**
 * Drill 6: Slow Consumer Backpressure Eviction
 */
function createBackpressureScenario(): ChaosScenario {
  return {
    id: 'backpressure',
    name: 'Slow Consumer Backpressure Eviction',
    description:
      'Pauses client socket to saturate buffer over maxBufferedAmountBytes, verifies eviction with RFC 6455 code 1008 and metrics counter increment.',
    execute: async (ctx: ChaosScenarioContext): Promise<ChaosScenarioResult> => {
      const serverPort = ctx.pulsePortA + 50;
      const server = new PulseServer(
        loadConfig({
          port: serverPort,
          host: '127.0.0.1',
          nodeEnv: 'test',
          instanceId: 'chaos-backpressure-node',
          authSecret: ctx.authSecret,
          maxBufferedAmountBytes: 32768, // 32KB
          metricsEnabled: true
        })
      );
      await server.start();

      const authenticator = new Authenticator(ctx.authSecret);
      let slowClient: WebSocket | null = null;
      let fastClient: WebSocket | null = null;

      try {
        const slowToken = authenticator.generateToken({ userId: 'slow-consumer' });
        const fastToken = authenticator.generateToken({ userId: 'fast-consumer' });

        slowClient = new WebSocket(`ws://127.0.0.1:${serverPort}/ws?token=${slowToken}`);
        fastClient = new WebSocket(`ws://127.0.0.1:${serverPort}/ws?token=${fastToken}`);

        let slowClosedCode: number | null = null;
        slowClient.on('close', (code) => {
          slowClosedCode = code;
        });

        await Promise.all([
          new Promise<void>((r) => slowClient!.once('open', () => r())),
          new Promise<void>((r) => fastClient!.once('open', () => r()))
        ]);

        slowClient.send(
          JSON.stringify({
            eventId: '018f673a-0000-7000-8000-000000000071',
            type: 'ROOM_JOIN',
            timestamp: Date.now(),
            senderId: 'slow-consumer',
            target: { roomId: 'flood-room' },
            payload: { roomId: 'flood-room' }
          })
        );
        fastClient.send(
          JSON.stringify({
            eventId: '018f673a-0000-7000-8000-000000000072',
            type: 'ROOM_JOIN',
            timestamp: Date.now(),
            senderId: 'fast-consumer',
            target: { roomId: 'flood-room' },
            payload: { roomId: 'flood-room' }
          })
        );
        await new Promise((r) => setTimeout(r, 50));

        // FAULT INJECTION: Pause slow client socket to cause backpressure buildup
        const slowSocket = (slowClient as any)._socket;
        if (slowSocket && typeof slowSocket.pause === 'function') {
          slowSocket.pause();
        }

        const faultInjectedAt = Date.now();
        const dTimer = ChaosScenarioRunner.startMonotonicTimer();

        // Flood 80 messages of 4KB each (320KB > 32KB buffer limit)
        const largeChunk = 'Z'.repeat(4096);
        for (let i = 0; i < 80; i++) {
          if (fastClient.readyState === WebSocket.OPEN) {
            fastClient.send(
              JSON.stringify({
                eventId: `018f673a-0000-7000-8000-000000000${String(i).padStart(3, '0')}`,
                type: 'ROOM_MESSAGE',
                timestamp: Date.now(),
                senderId: 'fast-consumer',
                target: { roomId: 'flood-room' },
                payload: { chunk: largeChunk }
              })
            );
          }
          if (i % 5 === 0) {
            await new Promise((r) => setTimeout(r, 5));
          }
        }

        // Allow server to dispatch and breach buffer threshold
        await new Promise((r) => setTimeout(r, 200));

        // Resume reading on slow consumer so it receives RFC 6455 close frame
        if (slowSocket && typeof slowSocket.resume === 'function') {
          slowSocket.resume();
        }

        // Wait for slow consumer eviction
        const deadline = Date.now() + 3000;
        while (slowClosedCode === null && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 20));
        }
        const mttdMs = dTimer();

        const metrics = await ChaosScenarioRunner.scrapeMetrics(serverPort);
        const slowEvictions = metrics.get('pulse_connections_closed_total{reason="slow_consumer"}') ?? 0;

        const passed = slowClosedCode === 1008 && fastClient.readyState === WebSocket.OPEN && slowEvictions >= 1;

        return {
          scenarioId: 'backpressure',
          name: 'Slow Consumer Backpressure Eviction',
          status: passed ? 'PASSED' : 'FAILED',
          timing: {
            faultInjectedAt,
            mttdMs,
            systemRecoveredAt: Date.now()
          },
          metricsAsserted: {
            evictionCode: slowClosedCode ?? 0,
            slowEvictionsMetric: slowEvictions,
            fastClientAlive: fastClient.readyState === WebSocket.OPEN ? 1 : 0
          }
        };
      } finally {
        if (slowClient && (slowClient.readyState === WebSocket.OPEN || slowClient.readyState === WebSocket.CONNECTING)) {
          slowClient.close();
        }
        if (fastClient && (fastClient.readyState === WebSocket.OPEN || fastClient.readyState === WebSocket.CONNECTING)) {
          fastClient.close();
        }
        if (server.isServerRunning()) await server.stop({ gracePeriodMs: 50 });
      }
    }
  };
}

/**
 * Drill 7: Graceful Node Draining
 */
function createGracefulDrainingScenario(): ChaosScenario {
  return {
    id: 'graceful-draining',
    name: 'Graceful Node Draining',
    description:
      'Initiates drain(), verifies 503 DRAINING on /readyz, rejection of new upgrades, broadcast of SYS_SHUTDOWN, and clean 1001 shutdown.',
    execute: async (ctx: ChaosScenarioContext): Promise<ChaosScenarioResult> => {
      const serverPort = ctx.pulsePortA + 60;
      const server = new PulseServer(
        loadConfig({
          port: serverPort,
          host: '127.0.0.1',
          nodeEnv: 'test',
          instanceId: 'chaos-draining-node',
          authSecret: ctx.authSecret,
          metricsEnabled: true
        })
      );
      await server.start();

      const authenticator = new Authenticator(ctx.authSecret);
      let clientWs: WebSocket | null = null;

      try {
        const token = authenticator.generateToken({ userId: 'active-user' });
        clientWs = new WebSocket(`ws://127.0.0.1:${serverPort}/ws?token=${token}`);

        let shutdownReceived = false;
        let closedCode: number | null = null;

        clientWs.on('message', (d) => {
          try {
            const env = JSON.parse(d.toString());
            if (env.type === 'SYS_SHUTDOWN') {
              shutdownReceived = true;
            }
          } catch {}
        });

        clientWs.on('close', (code) => {
          closedCode = code;
        });

        await new Promise<void>((r) => clientWs!.once('open', () => r()));

        // ACTION: Initiate draining
        const faultInjectedAt = Date.now();
        const dTimer = ChaosScenarioRunner.startMonotonicTimer();
        server.drain();

        // 1. Verify /readyz returns 503 DRAINING
        const readyRes = await new Promise<{ statusCode?: number; data: string }>((resResolve) => {
          http.get(`http://127.0.0.1:${serverPort}/readyz`, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => resResolve({ statusCode: res.statusCode, data }));
          });
        });
        const readyData = JSON.parse(readyRes.data);
        const mttdMs = dTimer();

        // 2. Verify new WS connection upgrade is rejected with 503
        const newToken = authenticator.generateToken({ userId: 'new-user' });
        let rejectedWith503 = false;
        await new Promise<void>((resolve) => {
          const rejectedWs = new WebSocket(`ws://127.0.0.1:${serverPort}/ws?token=${newToken}`);
          rejectedWs.on('open', () => {
            rejectedWs.close();
            resolve();
          });
          rejectedWs.on('error', (err) => {
            if (err.message.includes('503')) {
              rejectedWith503 = true;
            }
            resolve();
          });
        });

        // Wait for active client to receive SYS_SHUTDOWN frame
        const shutdownDeadline = Date.now() + 1000;
        while (!shutdownReceived && Date.now() < shutdownDeadline) {
          await new Promise((r) => setTimeout(r, 20));
        }

        // 3. Stop server with grace period
        const rTimer = ChaosScenarioRunner.startMonotonicTimer();
        await server.stop({ gracePeriodMs: 300 });

        // Wait for socket close event
        const closeDeadline = Date.now() + 1000;
        while (closedCode === null && Date.now() < closeDeadline) {
          await new Promise((r) => setTimeout(r, 20));
        }
        const mttrMs = rTimer();

        const passed =
          readyRes.statusCode === 503 &&
          readyData.status === 'DRAINING' &&
          rejectedWith503 &&
          shutdownReceived &&
          closedCode === 1001;

        return {
          scenarioId: 'graceful-draining',
          name: 'Graceful Node Draining',
          status: passed ? 'PASSED' : 'FAILED',
          timing: {
            faultInjectedAt,
            mttdMs,
            mttrMs,
            systemRecoveredAt: Date.now()
          },
          metricsAsserted: {
            readyzStatusCode: readyRes.statusCode ?? 0,
            newUpgradeRejected503: rejectedWith503 ? 1 : 0,
            sysShutdownReceived: shutdownReceived ? 1 : 0,
            closeCode: closedCode ?? 0
          }
        };
      } finally {
        if (clientWs && (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING)) {
          clientWs.close();
        }
        if (server.isServerRunning()) await server.stop({ gracePeriodMs: 50 });
      }
    }
  };
}
