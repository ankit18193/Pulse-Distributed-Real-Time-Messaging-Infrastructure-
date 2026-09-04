import EventEmitter from 'events';
import { Connection } from '../../src/core/Connection.js';
import { loadConfig } from '../../src/config/index.js';

describe('Connection WebSocket Backpressure (bufferedAmount protection)', () => {
  const createMockSocket = (bufferedAmount: number = 0) => {
    const socket: any = new EventEmitter();
    socket.readyState = 1; // WebSocket.OPEN
    socket.bufferedAmount = bufferedAmount;
    socket.send = jest.fn();
    socket.close = jest.fn((code?: number, reason?: string) => {
      socket.readyState = 2; // CLOSING
    });
    return socket;
  };

  test('sends successfully when bufferedAmount is below threshold', () => {
    const socket = createMockSocket(500); // 500 bytes < 1MB
    const conn = new Connection({
      socket,
      userId: 'alice',
      maxBufferedAmountBytes: 1024 // 1KB limit
    });

    const result = conn.send({ hello: 'world' });
    expect(result).toBe(true);
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(socket.close).not.toHaveBeenCalled();
  });

  test('drops message and closes socket with code 1008 when bufferedAmount exceeds threshold', () => {
    const socket = createMockSocket(2048); // 2KB > 1KB limit
    const conn = new Connection({
      socket,
      userId: 'alice',
      maxBufferedAmountBytes: 1024 // 1KB limit
    });

    const result = conn.send({ hello: 'world' });
    expect(result).toBe(false);
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledWith(1008, 'Policy Violation: Buffer overflow / slow consumer');
  });

  test('defaults maxBufferedAmountBytes to 1MB (1048576 bytes)', () => {
    const socket = createMockSocket(1048577); // 1 byte over 1MB
    const conn = new Connection({
      socket,
      userId: 'bob'
    });

    expect(conn.maxBufferedAmountBytes).toBe(1048576);

    const result = conn.send({ hello: 'world' });
    expect(result).toBe(false);
    expect(socket.close).toHaveBeenCalledWith(1008, 'Policy Violation: Buffer overflow / slow consumer');
  });

  test('config loader loads and validates maxBufferedAmountBytes correctly', () => {
    const defaultConfig = loadConfig();
    expect(defaultConfig.maxBufferedAmountBytes).toBe(1048576);

    const customConfig = loadConfig({ maxBufferedAmountBytes: 2097152 });
    expect(customConfig.maxBufferedAmountBytes).toBe(2097152);

    expect(() => loadConfig({ maxBufferedAmountBytes: 500 })).toThrow(
      'Invalid MAX_BUFFERED_AMOUNT_BYTES configuration: 500'
    );
  });
});
