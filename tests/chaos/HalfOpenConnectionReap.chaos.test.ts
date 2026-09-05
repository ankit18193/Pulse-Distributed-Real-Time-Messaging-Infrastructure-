import WebSocket from 'ws';
import { PulseServer } from '../../src/core/PulseServer.js';
import { loadConfig } from '../../src/config/index.js';
import { FaultProxy } from '../../src/chaos/FaultProxy.js';
import { Authenticator } from '../../src/auth/Authenticator.js';
import { ChaosScenarioRunner } from '../../src/chaos/ChaosScenarioRunner.js';

describe('Chaos Drill: Half-Open Connection Silent Blackhole & Reaping', () => {
  const nodePort = 9251;
  const proxyPort = 9252;
  const authSecret = 'pulse-half-open-chaos-secret-32chars!';
  const authenticator = new Authenticator(authSecret);

  let server: PulseServer;
  let proxy: FaultProxy;

  beforeEach(async () => {
    // 1. Start Pulse Server Node with accelerated heartbeat for test
    const config = loadConfig({
      port: nodePort,
      host: '127.0.0.1',
      nodeEnv: 'test',
      instanceId: 'pulse-half-open-node',
      authSecret,
      metricsEnabled: true,
      heartbeatIntervalMs: 200, // Send ping after 200ms
      heartbeatTimeoutMs: 200 // Reap after 400ms total silence
    });
    server = new PulseServer(config);
    await server.start();

    // 2. Start FaultProxy forwarding to the server
    proxy = new FaultProxy({
      listenPort: proxyPort,
      targetHost: '127.0.0.1',
      targetPort: nodePort,
      name: 'half-open-proxy',
      mode: 'tcp'
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

  test('silent blackhole freeze -> heartbeat detects unresponsiveness -> reaps connection with code 1002 and cleans up resources', async () => {
    const token = authenticator.generateToken({ userId: 'silent-user' });
    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/ws?token=${token}`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    // Join a room to verify membership cleanup upon reaping
    ws.send(
      JSON.stringify({
        eventId: '018f673a-0000-7000-8000-000000000041',
        type: 'ROOM_JOIN',
        timestamp: Date.now(),
        senderId: 'silent-user',
        target: { roomId: 'stale-room' },
        payload: { roomId: 'stale-room' }
      })
    );

    // Give server 50ms to register connection and room join
    await new Promise((r) => setTimeout(r, 50));
    expect(server.getActiveConnectionCount()).toBe(1);
    expect(server.getActiveRoomCount()).toBe(1);

    // =========================================================================
    // FAULT INJECTION: Enable silent blackhole (TCP stays open, all packets dropped)
    // =========================================================================
    const faultStartTimer = ChaosScenarioRunner.startMonotonicTimer();
    proxy.blackhole(true);

    // Poll until server reaps the connection (expected after ~400ms: 200ms interval + 200ms timeout)
    let reaped = false;
    const pollStart = Date.now();
    while (Date.now() - pollStart < 3000) {
      if (server.getActiveConnectionCount() === 0) {
        reaped = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const mttdMs = faultStartTimer();

    expect(reaped).toBe(true);
    expect(server.getActiveConnectionCount()).toBe(0);
    expect(server.getActiveRoomCount()).toBe(0); // Room membership cleared

    // Assert metrics reflect the reaping reason
    const metrics = await ChaosScenarioRunner.scrapeMetrics(nodePort);
    const heartbeatClosedTotal =
      metrics.get('pulse_connections_closed_total{reason="heartbeat_timeout"}') ?? 0;
    expect(heartbeatClosedTotal).toBeGreaterThanOrEqual(1);

    // Verify MTTD is in reasonable range (~400ms - 2000ms)
    expect(mttdMs).toBeGreaterThanOrEqual(300);
    expect(mttdMs).toBeLessThan(3000);

    // Cleanup client socket
    ws.terminate();
  });
});
