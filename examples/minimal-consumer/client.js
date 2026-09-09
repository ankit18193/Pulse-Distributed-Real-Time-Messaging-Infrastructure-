import WebSocket from 'ws';
import { Authenticator } from '@ankit18193/pulse';

const port = parseInt(process.env.PORT || '8888', 10);
const authSecret = process.env.AUTH_SECRET || 'pulse-dev-secret-key-32chars-min';
const userId = process.argv[2] || 'bob';
const roomId = 'engineering-lobby';

const authenticator = new Authenticator(authSecret);
const token = authenticator.generateToken({ userId, roles: ['member'] });

console.log(`Connecting as ${userId} to ws://localhost:${port}...`);
const ws = new WebSocket(`ws://localhost:${port}?token=${token}`);

ws.on('open', () => {
  console.log(`WebSocket connection opened. Awaiting server handshake confirmation...`);
});

ws.on('message', (raw) => {
  const event = JSON.parse(raw.toString());
  console.log(`[Received ${event.type}]`, JSON.stringify(event.payload));

  if (event.type === 'SYS_CONNECT_ACK') {
    console.log(`Authenticated successfully as ${userId}! Joining room: ${roomId}`);
    ws.send(JSON.stringify({
      eventId: `join-${Date.now()}`,
      type: 'ROOM_JOIN',
      timestamp: Date.now(),
      senderId: userId,
      target: { roomId },
      payload: { roomId }
    }));
  } else if (event.type === 'ROOM_JOIN_ACK') {
    console.log(`Joined room ${roomId}! Sending greeting message...`);
    ws.send(JSON.stringify({
      eventId: `msg-${Date.now()}`,
      type: 'ROOM_MESSAGE',
      timestamp: Date.now(),
      senderId: userId,
      target: { roomId },
      ackRequired: true,
      payload: { text: `Hello from ${userId} via @ankit18193/pulse!` }
    }));
  } else if (event.type === 'DELIVERY_ACK') {
    console.log('Delivery ACK verified! Demo sequence completed successfully.');
    setTimeout(() => {
      ws.close();
      process.exit(0);
    }, 1000);
  }
});

ws.on('error', (err) => {
  console.error('WebSocket client error:', err.message);
  process.exit(1);
});
