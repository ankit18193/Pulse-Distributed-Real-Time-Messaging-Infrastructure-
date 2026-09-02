import net from 'net';
import { PulseServer } from '../../src/core/PulseServer';
import { loadConfig } from '../../src/config';

describe('Clean HTTP Handshake Rejection (Phase 2)', () => {
  let server: PulseServer;
  const testPort = 9185;

  beforeAll(async () => {
    const config = loadConfig({
      port: testPort,
      instanceId: 'test-handshake-node',
      authSecret: 'test-secret-must-be-at-least-32-characters-long'
    });
    server = new PulseServer(config);
    await server.start();
  });

  afterAll(async () => {
    await server.stop({ gracePeriodMs: 50 });
  });

  it('responds with clean HTTP 401 and closes socket on missing token', async () => {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection({ port: testPort, host: '127.0.0.1' }, () => {
        socket.write(
          'GET /ws HTTP/1.1\r\n' +
            'Host: 127.0.0.1\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
            'Sec-WebSocket-Version: 13\r\n\r\n'
        );
      });

      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8');
      });

      socket.on('end', () => {
        resolve(data);
      });

      socket.on('error', (err) => {
        reject(err);
      });
    });

    expect(response).toContain('HTTP/1.1 401 Unauthorized');
    expect(response).toContain('Connection: close');
    expect(response).toContain('application/json');
    expect(response).toContain('Missing authentication token');
  });

  it('responds with clean HTTP 401 on tampered token', async () => {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection({ port: testPort, host: '127.0.0.1' }, () => {
        socket.write(
          'GET /ws?token=invalid.tampered.token HTTP/1.1\r\n' +
            'Host: 127.0.0.1\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
            'Sec-WebSocket-Version: 13\r\n\r\n'
        );
      });

      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8');
      });

      socket.on('end', () => {
        resolve(data);
      });

      socket.on('error', (err) => {
        reject(err);
      });
    });

    expect(response).toContain('HTTP/1.1 401 Unauthorized');
    expect(response).toContain('Connection: close');
    expect(response).toContain('Malformed token structure');
  });
});
