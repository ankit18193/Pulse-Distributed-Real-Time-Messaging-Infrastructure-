import WebSocket from 'ws';
import { PulseServer } from '../../src/core/PulseServer';
import { loadConfig } from '../../src/config';
import { PulseEventEnvelope } from '../../src/types';

describe('Phase 10 — Soak Endurance & Memory Stability', () => {
  // Configurable soak duration: default 3 minutes (180,000ms), or lower via env SOAK_DURATION_MS
  const soakDurationMs = parseInt(process.env.SOAK_DURATION_MS || '180000', 10);
  const testPort = 9294;
  const authSecret = 'phase10-soak-secret-32-chars-long-secure!';

  const config = loadConfig({
    port: testPort,
    host: '127.0.0.1',
    nodeEnv: 'test',
    instanceId: 'pulse-soak-node',
    authSecret,
    maxConnections: 1000,
    redisEnabled: false
  });

  let server: PulseServer;

  beforeAll(async () => {
    server = new PulseServer(config);
    await server.start();
  });

  afterAll(async () => {
    await server.stop({ gracePeriodMs: 200 });
  });

  function forceGc(): void {
    if (typeof (global as any).gc === 'function') {
      (global as any).gc();
    }
  }

  test(
    'sustains high churn for endurance duration with < 15% post-GC heap memory growth',
    async () => {
      console.log(`[SOAK] Starting sustained endurance soak test for ${soakDurationMs / 1000}s...`);

      // Baseline stabilization and GC
      forceGc();
      await new Promise((r) => setTimeout(r, 100));
      forceGc();

      const baselineHeap = process.memoryUsage().heapUsed;
      let peakHeap = baselineHeap;
      let totalMessagesSent = 0;
      let totalCycles = 0;

      const startTime = Date.now();
      const concurrency = 5;

      async function runClientCycle(clientId: number): Promise<void> {
        const token = server.getAuthenticator().generateToken({ userId: `soak-user-${clientId}` });
        const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws?token=${token}`);

        await new Promise<void>((resolve, reject) => {
          ws.on('open', () => resolve());
          ws.on('error', reject);
        });

        // Join 3 rooms
        const roomId = `soak-room-${clientId % 5}`;
        ws.send(JSON.stringify({
          eventId: `0191c98a-0000-7000-8000-${String(totalMessagesSent++).padStart(12, '0')}`,
          type: 'ROOM_JOIN',
          timestamp: Date.now(),
          senderId: `soak-user-${clientId}`,
          target: { roomId }
        }));

        // Send 5 messages
        for (let m = 0; m < 5; m++) {
          ws.send(JSON.stringify({
            eventId: `0191c98a-0000-7000-8000-${String(totalMessagesSent++).padStart(12, '0')}`,
            type: 'ROOM_MESSAGE',
            timestamp: Date.now(),
            senderId: `soak-user-${clientId}`,
            target: { roomId },
            payload: { text: `Soak payload ${m}`, sequence: m }
          }));
        }

        // Wait a brief tick for server to process
        await new Promise((r) => setTimeout(r, 20));

        // Disconnect
        await new Promise<void>((resolve) => {
          ws.on('close', () => resolve());
          ws.close();
        });

        totalCycles++;
      }

      // Run continuously until soakDurationMs has elapsed
      while (Date.now() - startTime < soakDurationMs) {
        const batch: Promise<void>[] = [];
        for (let i = 0; i < concurrency; i++) {
          batch.push(runClientCycle(i));
        }
        await Promise.all(batch);

        const currentHeap = process.memoryUsage().heapUsed;
        if (currentHeap > peakHeap) {
          peakHeap = currentHeap;
        }

        // Brief delay between batches
        await new Promise((r) => setTimeout(r, 10));
      }

      // Wait for any trailing processing and perform final GC
      await new Promise((r) => setTimeout(r, 200));
      forceGc();
      await new Promise((r) => setTimeout(r, 100));
      forceGc();

      const finalHeap = process.memoryUsage().heapUsed;
      const heapDeltaBytes = finalHeap - baselineHeap;
      const growthRatio = heapDeltaBytes / baselineHeap;
      const growthPercent = (growthRatio * 100).toFixed(2);

      console.log('[SOAK] Endurance test telemetry results:', {
        durationSeconds: ((Date.now() - startTime) / 1000).toFixed(1),
        totalCycles,
        totalMessagesSent,
        baselineHeapMB: (baselineHeap / 1024 / 1024).toFixed(2),
        peakHeapMB: (peakHeap / 1024 / 1024).toFixed(2),
        finalHeapMB: (finalHeap / 1024 / 1024).toFixed(2),
        growthPercent: `${growthPercent}%`
      });

      // Assert post-GC heap growth is < 15% (0.15)
      expect(growthRatio).toBeLessThan(0.15);
    },
    soakDurationMs + 30000 // Test timeout: duration + 30s buffer
  );
});
