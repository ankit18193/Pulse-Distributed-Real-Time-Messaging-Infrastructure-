import { WebSocket } from 'ws';
import { PulseServer } from '../../src/core/PulseServer';
import { loadConfig } from '../../src/config';
import { generateUUIDv7 } from '../../src/utils/uuidv7';
import { PulseEventEnvelope } from '../../src/types';

/**
 * Client session simulating usePulseSocket lifecycle, backoff, and tab navigation.
 */
class TestSandboxSocketClient {
  public status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error' = 'disconnected';
  public lastError: string | null = null;
  public ws: WebSocket | null = null;
  public pingsReceived: PulseEventEnvelope[] = [];
  public pongsSent: PulseEventEnvelope[] = [];
  public messagesReceived: PulseEventEnvelope[] = [];
  public subscribedRooms: string[] = [];
  public reconnectAttempts = 0;
  public reconnectTimer: NodeJS.Timeout | null = null;
  public shouldConnect = false;
  public intentionalDisconnect = false;
  public activeUrl: string = '';
  public socketCreationCount = 0;
  public autoResumeSession: { autoResume: boolean; url: string; rooms: string[] } | null = null;

  public connect(url: string, isReconnecting: boolean = false): void {
    // Prevent duplicate connections if already open or connecting to same URL
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) &&
      this.activeUrl === url &&
      !isReconnecting
    ) {
      return;
    }

    this.shouldConnect = true;
    this.intentionalDisconnect = false;
    this.activeUrl = url;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.cleanupSocket(this.ws);
    }

    this.status = isReconnecting ? 'reconnecting' : 'connecting';
    this.socketCreationCount++;

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.status = 'connected';
      this.lastError = null;
      this.reconnectAttempts = 0;

      // Resubscribe to existing desired rooms
      this.subscribedRooms.forEach((room) => {
        ws.send(JSON.stringify({
          type: 'ROOM_JOIN',
          target: { roomId: room },
          payload: { roomId: room }
        }));
      });
    });

    ws.on('message', (data: Buffer | string) => {
      if (this.ws !== ws) return;
      try {
        const parsed = JSON.parse(data.toString()) as PulseEventEnvelope;
        if (parsed) {
          this.messagesReceived.push(parsed);
          if (parsed.type === 'SYS_PING') {
            this.pingsReceived.push(parsed);

            // Canonical SYS_PONG response
            const pongEnvelope: PulseEventEnvelope = {
              eventId: generateUUIDv7(),
              type: 'SYS_PONG',
              timestamp: Date.now(),
              senderId: 'sandbox_user',
              correlationId: parsed.eventId || parsed.correlationId,
              payload: {}
            };
            this.pongsSent.push(pongEnvelope);

            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(pongEnvelope));
            }
          }
        }
      } catch {
        // ignore non-JSON
      }
    });

    ws.on('error', (err) => {
      if (this.ws !== ws) return;
      this.status = 'error';
      this.lastError = err.message;
    });

    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = null;

      if (this.intentionalDisconnect || !this.shouldConnect) {
        this.status = 'disconnected';
        return;
      }

      this.scheduleReconnect();
    });
  }

  public broadcastRoomMessage(roomId: string, rawOrPayload: string | Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    let frameToSend: Record<string, unknown>;
    try {
      const parsed = typeof rawOrPayload === 'string' ? JSON.parse(rawOrPayload) : rawOrPayload;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const candidateType = parsed.type;
        if (candidateType === 'ROOM_MESSAGE' || candidateType === 'DIRECT_MESSAGE') {
          frameToSend = {
            ...parsed,
            target: parsed.target && typeof parsed.target === 'object' ? parsed.target : { roomId },
            timestamp: parsed.timestamp || Date.now(),
            correlationId: parsed.correlationId || `corr-${Date.now()}`,
            ackRequired: parsed.ackRequired ?? true
          };
        } else if (candidateType === 'MESSAGE_SEND' || candidateType === 'BROADCAST') {
          const payloadData = parsed.payload !== undefined
            ? parsed.payload
            : parsed.data !== undefined
              ? parsed.data
              : parsed;
          frameToSend = {
            type: 'ROOM_MESSAGE',
            target: { roomId: (parsed.target as any)?.roomId || parsed.room || roomId },
            payload: typeof payloadData === 'object' && payloadData !== null ? payloadData : { content: String(payloadData) },
            timestamp: Date.now(),
            correlationId: parsed.correlationId || `corr-${Date.now()}`,
            ackRequired: true
          };
        } else {
          frameToSend = {
            type: 'ROOM_MESSAGE',
            target: { roomId },
            payload: parsed,
            timestamp: Date.now(),
            correlationId: `corr-${Date.now()}`,
            ackRequired: true
          };
        }
      } else {
        frameToSend = {
          type: 'ROOM_MESSAGE',
          target: { roomId },
          payload: { content: parsed },
          timestamp: Date.now(),
          correlationId: `corr-${Date.now()}`,
          ackRequired: true
        };
      }
    } catch {
      frameToSend = {
        type: 'ROOM_MESSAGE',
        target: { roomId },
        payload: { content: String(rawOrPayload) },
        timestamp: Date.now(),
        correlationId: `corr-${Date.now()}`,
        ackRequired: true
      };
    }

    this.ws.send(JSON.stringify(frameToSend));
  }

  public scheduleReconnect(): void {
    if (!this.shouldConnect || this.intentionalDisconnect) return;

    if (this.reconnectAttempts >= 5) {
      this.status = 'disconnected';
      this.lastError = 'Reconnection failed after 5 attempts. Click Connect to retry.';
      this.shouldConnect = false;
      return;
    }

    this.status = 'reconnecting';
    this.reconnectAttempts++;

    // Fast backoff for test execution (base 50ms)
    const delay = Math.min(300, 50 * Math.pow(1.5, this.reconnectAttempts - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldConnect && !this.intentionalDisconnect && this.activeUrl) {
        this.connect(this.activeUrl, true);
      }
    }, delay);
  }

  public disconnect(): void {
    this.shouldConnect = false;
    this.intentionalDisconnect = true;
    this.reconnectAttempts = 0;
    this.autoResumeSession = null;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.cleanupSocket(this.ws);
      this.ws.close(1000, 'User disconnected');
      this.ws = null;
    }
    this.status = 'disconnected';
  }

  public handleVisibilityChange(isVisible: boolean): void {
    if (isVisible) {
      if (!this.shouldConnect || this.intentionalDisconnect) return;
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
        return; // Socket is alive, do not duplicate
      }
      if (this.activeUrl) {
        this.connect(this.activeUrl, true);
      }
    }
  }

  // Dashboard tab navigation: leave sandbox tab (Option B)
  public handleTabLeave(): void {
    if (this.status === 'connected' || this.status === 'connecting' || this.status === 'reconnecting') {
      this.autoResumeSession = {
        autoResume: true,
        url: this.activeUrl,
        rooms: [...this.subscribedRooms]
      };
    }
    // Explicitly disconnect when leaving tab to free server resources
    if (this.ws) {
      this.cleanupSocket(this.ws);
      this.ws.close(1000, 'Navigated away from sandbox');
      this.ws = null;
    }
    this.status = 'disconnected';
  }

  // Dashboard tab navigation: return to sandbox tab (Option B)
  public handleTabReturn(): void {
    if (this.autoResumeSession && this.autoResumeSession.autoResume) {
      this.subscribedRooms = [...this.autoResumeSession.rooms];
      this.connect(this.autoResumeSession.url, false);
    }
  }

  private cleanupSocket(ws: WebSocket): void {
    ws.removeAllListeners('open');
    ws.removeAllListeners('message');
    ws.removeAllListeners('error');
    ws.removeAllListeners('close');
  }
}

describe('Traffic Sandbox WebSocket Lifecycle & Heartbeat', () => {
  let server: PulseServer;
  const testPort = 9295;
  const authSecret = 'sandbox-lifecycle-secret-key-32chars-min';
  let token: string;
  let serverWsUrl: string;

  beforeAll(async () => {
    const config = loadConfig({
      port: testPort,
      instanceId: 'test-sandbox-node',
      authSecret,
      heartbeatIntervalMs: 150, // 150ms interval for fast test
      heartbeatTimeoutMs: 150   // 150ms timeout for fast test
    });
    server = new PulseServer(config);
    await server.start();
    token = server.getAuthenticator().generateToken({ userId: 'sandbox_user' });
    serverWsUrl = `ws://127.0.0.1:${testPort}/ws?token=${encodeURIComponent(token)}`;
  });

  afterAll(async () => {
    await server.stop({ gracePeriodMs: 50 });
  });

  it('1. Detects incoming SYS_PING and responds with canonical SYS_PONG format', async () => {
    const client = new TestSandboxSocketClient();
    client.connect(serverWsUrl);

    // Wait for connection and first heartbeat ping
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for SYS_PING')), 1000);
      const interval = setInterval(() => {
        if (client.pingsReceived.length > 0 && client.pongsSent.length > 0) {
          clearTimeout(timeout);
          clearInterval(interval);
          resolve();
        }
      }, 20);
    });

    expect(client.pingsReceived.length).toBeGreaterThanOrEqual(1);
    expect(client.pongsSent.length).toBeGreaterThanOrEqual(1);

    const ping = client.pingsReceived[0];
    const pong = client.pongsSent[0];

    expect(ping.type).toBe('SYS_PING');
    expect(pong.type).toBe('SYS_PONG');
    expect(pong.correlationId).toBe(ping.eventId);
    expect(pong.payload).toEqual({});
    expect(typeof pong.timestamp).toBe('number');

    client.disconnect();
  });

  it('2. Heartbeat keeps an idle connection alive, while an unresponsive connection is reaped (1002)', async () => {
    // Client A responds to pings
    const clientA = new TestSandboxSocketClient();
    clientA.connect(serverWsUrl);

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (clientA.status === 'connected') {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    // Client B connects raw and intentionally ignores SYS_PING
    const clientBWs = new WebSocket(serverWsUrl);
    let clientBCloseCode: number | null = null;
    let clientBCloseReason: string | null = null;

    clientBWs.on('close', (code, reason) => {
      clientBCloseCode = code;
      clientBCloseReason = reason.toString();
    });

    // Wait for client B to be reaped by HeartbeatManager (> 150ms interval + 150ms timeout)
    const reapStart = Date.now();
    while (clientBCloseCode === null && Date.now() - reapStart < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }

    try {
      // Client A is STILL OPEN because it responded to SYS_PING with SYS_PONG!
      expect(clientA.ws?.readyState).toBe(WebSocket.OPEN);
      expect(clientA.pongsSent.length).toBeGreaterThanOrEqual(1);

      // Client B was reaped by HeartbeatManager with code 1002 because it failed to send SYS_PONG!
      expect(clientBCloseCode).toBe(1002);
      expect(clientBCloseReason).toContain('Heartbeat timeout');
    } finally {
      clientA.disconnect();
      try {
        if (clientBWs.readyState === WebSocket.OPEN || clientBWs.readyState === WebSocket.CONNECTING) {
          clientBWs.terminate();
        }
      } catch {
        // ignore
      }
    }
  });

  it('3. Intentional user disconnect cancels backoff and does not reconnect', async () => {
    const client = new TestSandboxSocketClient();
    client.connect(serverWsUrl);

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (client.status === 'connected') {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    const creationsBeforeDisconnect = client.socketCreationCount;

    // Explicit user disconnect
    client.disconnect();

    expect(client.status).toBe('disconnected');
    expect(client.reconnectTimer).toBeNull();
    expect(client.shouldConnect).toBe(false);

    // Wait 200ms to ensure no background reconnect triggers
    await new Promise((r) => setTimeout(r, 200));

    expect(client.status).toBe('disconnected');
    expect(client.socketCreationCount).toBe(creationsBeforeDisconnect);
  });

  it('4. Unexpected disconnect triggers bounded exponential backoff and reconnects', async () => {
    const client = new TestSandboxSocketClient();
    client.connect(serverWsUrl);

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (client.status === 'connected') {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    expect(client.status).toBe('connected');

    // Simulate unexpected network drop / server termination without calling client.disconnect()
    client.ws?.terminate();

    // Verify immediate transition to 'reconnecting'
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (client.status === 'reconnecting') {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    expect(client.status).toBe('reconnecting');
    expect(client.reconnectAttempts).toBe(1);

    // Verify client automatically recovers and reconnects
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for auto-reconnect')), 1000);
      const interval = setInterval(() => {
        if (client.status === 'connected') {
          clearTimeout(timeout);
          clearInterval(interval);
          resolve();
        }
      }, 20);
    });

    expect(client.status).toBe('connected');
    expect(client.reconnectAttempts).toBe(0); // Reset upon successful reconnect

    client.disconnect();
  });

  it('5. Dashboard tab navigation explicitly disconnects on leave and cleanly reconnects on return', async () => {
    const client = new TestSandboxSocketClient();
    client.subscribedRooms = ['lobby', 'alerts'];
    client.connect(serverWsUrl);

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (client.status === 'connected') {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    expect(server.getConnectionManager().getCount()).toBe(1);

    // Step A: User switches tabs away from Sandbox (simulating component unmount)
    client.handleTabLeave();

    expect(client.status).toBe('disconnected');
    expect(client.ws).toBeNull();
    expect(client.autoResumeSession).toEqual({
      autoResume: true,
      url: serverWsUrl,
      rooms: ['lobby', 'alerts']
    });

    // Verify connection dropped on server to free memory and presence
    const drainStart = Date.now();
    while (server.getConnectionManager().getCount() > 0 && Date.now() - drainStart < 2000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(server.getConnectionManager().getCount()).toBe(0);

    // Step B: User returns to Sandbox tab (simulating component remount)
    client.handleTabReturn();

    // Verify clean reconnection
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for tab return reconnect')), 1000);
      const interval = setInterval(() => {
        if (client.status === 'connected') {
          clearTimeout(timeout);
          clearInterval(interval);
          resolve();
        }
      }, 20);
    });

    expect(client.status).toBe('connected');
    expect(server.getConnectionManager().getCount()).toBe(1);

    // Step C: If user explicitly disconnected before leaving, returning does NOT reconnect
    client.disconnect();
    expect(client.autoResumeSession).toBeNull();

    client.handleTabLeave();
    client.handleTabReturn();
    expect(client.status).toBe('disconnected');

    client.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('6. Does not create duplicate socket connections on redundant connect or visibility events', async () => {
    const client = new TestSandboxSocketClient();
    client.connect(serverWsUrl);

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (client.status === 'connected') {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    const initialCreationCount = client.socketCreationCount;
    expect(initialCreationCount).toBe(1);

    // 1. Redundant connect call with identical URL
    client.connect(serverWsUrl);
    expect(client.socketCreationCount).toBe(initialCreationCount);

    // 2. Visibility change to visible when socket is already open
    client.handleVisibilityChange(true);
    expect(client.socketCreationCount).toBe(initialCreationCount);

    // Verify active server connection count remains exactly 1
    expect(server.getConnectionManager().getCount()).toBe(1);

    client.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('7. Dispatches canonical ROOM_MESSAGE frame targeting selected room, preserves payload, and confirms DELIVERY_ACK with zero BROADCAST wrapper', async () => {
    const clientA = new TestSandboxSocketClient();
    const clientB = new TestSandboxSocketClient();

    clientA.connect(serverWsUrl);
    clientB.connect(serverWsUrl);

    // Wait for both to connect
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (clientA.status === 'connected' && clientB.status === 'connected') {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    const testRoom = 'p4-test-room';

    // Both join p4-test-room
    clientA.ws?.send(JSON.stringify({
      type: 'ROOM_JOIN',
      target: { roomId: testRoom },
      payload: { roomId: testRoom }
    }));
    clientB.ws?.send(JSON.stringify({
      type: 'ROOM_JOIN',
      target: { roomId: testRoom },
      payload: { roomId: testRoom }
    }));

    // Wait for ROOM_JOIN_ACK on both
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        const ackA = clientA.messagesReceived.some((m) => m.type === 'ROOM_JOIN_ACK' && m.target?.roomId === testRoom);
        const ackB = clientB.messagesReceived.some((m) => m.type === 'ROOM_JOIN_ACK' && m.target?.roomId === testRoom);
        if (ackA && ackB) {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    // Case A: Traffic Sandbox dispatches raw UI payload mimicking the exact P4 reported frame:
    // { type: "MESSAGE_SEND", target: { roomId: "p4-test-room" }, payload: { content: "Hello from P4" } }
    const p4Payload = JSON.stringify({
      type: 'MESSAGE_SEND',
      target: { roomId: testRoom },
      payload: { content: 'Hello from P4' }
    });

    clientA.broadcastRoomMessage(testRoom, p4Payload);

    // Verify Client A receives canonical DELIVERY_ACK with status: ACCEPTED
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        const deliveryAck = clientA.messagesReceived.find((m) => m.type === 'DELIVERY_ACK');
        if (deliveryAck) {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    const deliveryAck = clientA.messagesReceived.find((m) => m.type === 'DELIVERY_ACK')!;
    expect(deliveryAck).toBeDefined();
    expect((deliveryAck.payload as any).status).toBe('ACCEPTED');

    // Verify Client B received canonical ROOM_MESSAGE with preserved payload
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        const roomMsg = clientB.messagesReceived.find((m) => m.type === 'ROOM_MESSAGE');
        if (roomMsg) {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    const receivedOnB = clientB.messagesReceived.find((m) => m.type === 'ROOM_MESSAGE')!;
    expect(receivedOnB).toBeDefined();
    expect(receivedOnB.type).toBe('ROOM_MESSAGE');
    expect(receivedOnB.target?.roomId).toBe(testRoom);
    expect((receivedOnB.payload as any).content).toBe('Hello from P4');

    // Verify NO SYS_ERROR with UNRECOGNIZED_EVENT_TYPE was ever emitted
    const sysErrors = clientA.messagesReceived.filter((m) => m.type === 'SYS_ERROR');
    expect(sysErrors).toHaveLength(0);

    // Case B: Dispatches custom JSON object payload (e.g. { message: "Hello from Mission Control" })
    const customPayload = { message: 'Hello from Mission Control', version: 'p4-final' };
    clientA.broadcastRoomMessage(testRoom, customPayload);

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        const bMessages = clientB.messagesReceived.filter((m) => m.type === 'ROOM_MESSAGE');
        if (bMessages.length >= 2) {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    const secondMsgOnB = clientB.messagesReceived.filter((m) => m.type === 'ROOM_MESSAGE')[1];
    expect(secondMsgOnB.payload).toEqual(customPayload);
    expect(secondMsgOnB.target?.roomId).toBe(testRoom);

    clientA.disconnect();
    clientB.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  });
});
