import net from 'net';
import { FaultProxy } from '../../src/chaos/FaultProxy.js';

describe('FaultProxy — TCP Fault Interception Semantics', () => {
  let echoServer: net.Server;
  let echoPort: number;
  let proxy: FaultProxy;
  let proxyPort: number;

  beforeEach(async () => {
    // 1. Start a simple TCP echo server on an ephemeral port
    await new Promise<void>((resolve) => {
      echoServer = net.createServer((socket) => {
        socket.pipe(socket);
      });
      echoServer.listen(0, '127.0.0.1', () => {
        echoPort = (echoServer.address() as net.AddressInfo).port;
        resolve();
      });
    });

    // 2. Start FaultProxy forwarding to the echo server
    proxy = new FaultProxy({
      listenPort: 0,
      targetHost: '127.0.0.1',
      targetPort: echoPort,
      name: 'test-echo-proxy',
      mode: 'tcp'
    });
    await proxy.start();
    proxyPort = proxy.getBoundPort();
  });

  afterEach(async () => {
    await proxy.close();
    await new Promise<void>((resolve) => {
      echoServer.close(() => resolve());
    });
  });

  test('forwards full-duplex TCP traffic under NORMAL conditions', async () => {
    const client = net.connect({ host: '127.0.0.1', port: proxyPort });
    const received: Buffer[] = [];

    await new Promise<void>((resolve) => {
      client.once('connect', resolve);
    });

    client.on('data', (chunk) => {
      received.push(chunk);
    });

    client.write(Buffer.from('ping-pulse-raw-tcp'));

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (Buffer.concat(received).toString() === 'ping-pulse-raw-tcp') {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    expect(Buffer.concat(received).toString()).toBe('ping-pulse-raw-tcp');
    client.destroy();
  });

  test('sever() abruptly destroys active sockets and rejects new connections without resurrection', async () => {
    const client = net.connect({ host: '127.0.0.1', port: proxyPort });
    await new Promise<void>((resolve) => client.once('connect', resolve));

    let clientClosed = false;
    client.on('close', () => {
      clientClosed = true;
    });

    // Trigger sever
    proxy.sever();
    expect(proxy.getState()).toBe('SEVERED');

    // Sockets should be destroyed
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (clientClosed) {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });
    expect(clientClosed).toBe(true);

    // New connections attempted while severed are destroyed immediately
    const client2 = net.connect({ host: '127.0.0.1', port: proxyPort });
    let client2Closed = false;
    client2.on('close', () => {
      client2Closed = true;
    });
    client2.on('error', () => {}); // Catch ECONNRESET

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (client2Closed) {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });
    expect(client2Closed).toBe(true);

    // Restoring proxy allows NEW connections, but does NOT magically revive dead client1
    proxy.restore();
    expect(proxy.getState()).toBe('NORMAL');
    expect(client.destroyed).toBe(true);

    const client3 = net.connect({ host: '127.0.0.1', port: proxyPort });
    await new Promise<void>((resolve) => client3.once('connect', resolve));
    expect(client3.destroyed).toBe(false);
    client3.destroy();
  });

  test('blackhole(true) silently discards bytes while keeping TCP connection established', async () => {
    const client = net.connect({ host: '127.0.0.1', port: proxyPort });
    const received: Buffer[] = [];
    await new Promise<void>((resolve) => client.once('connect', resolve));

    client.on('data', (chunk) => {
      received.push(chunk);
    });

    // Enable blackhole
    proxy.blackhole(true);
    expect(proxy.getState()).toBe('BLACKHOLE');

    client.write(Buffer.from('silent-blackhole-test'));

    // Wait 150ms to ensure no echo arrives
    await new Promise((r) => setTimeout(r, 150));
    expect(received).toHaveLength(0);
    expect(client.destroyed).toBe(false); // Connection is still established

    // Disable blackhole (restore) -> subsequent writes should now echo
    proxy.blackhole(false);
    expect(proxy.getState()).toBe('NORMAL');

    client.write(Buffer.from('after-blackhole'));
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (Buffer.concat(received).toString().includes('after-blackhole')) {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    expect(Buffer.concat(received).toString()).toBe('after-blackhole');
    client.destroy();
  });

  test('injectLatency() delays transmission while preserving FIFO chunk order', async () => {
    const client = net.connect({ host: '127.0.0.1', port: proxyPort });
    const received: Buffer[] = [];
    await new Promise<void>((resolve) => client.once('connect', resolve));

    client.on('data', (chunk) => {
      received.push(chunk);
    });

    proxy.injectLatency({ minDelayMs: 60, maxDelayMs: 80 });
    const startTime = Date.now();

    client.write(Buffer.from('chunk1;'));
    client.write(Buffer.from('chunk2;'));
    client.write(Buffer.from('chunk3;'));

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (Buffer.concat(received).toString() === 'chunk1;chunk2;chunk3;') {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(Buffer.concat(received).toString()).toBe('chunk1;chunk2;chunk3;');
    client.destroy();
  });
});
