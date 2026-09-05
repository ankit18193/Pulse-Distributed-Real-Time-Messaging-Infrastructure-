import { WebSocketFrameFilter } from '../../src/chaos/WebSocketFrameFilter.js';

describe('WebSocketFrameFilter — RFC 6455 Frame Reconstruction & Dropping', () => {
  /**
   * Helper to encode a valid RFC 6455 frame into a Buffer.
   */
  function encodeFrame(options: {
    opcode?: number;
    fin?: boolean;
    masked?: boolean;
    maskKey?: Buffer;
    payload: Buffer | string;
  }): Buffer {
    const fin = options.fin ?? true;
    const opcode = options.opcode ?? 0x1; // text
    const masked = options.masked ?? false;
    const payloadBuf =
      typeof options.payload === 'string'
        ? Buffer.from(options.payload, 'utf8')
        : options.payload;

    const byte0 = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
    let headerBytes: Buffer;
    const len = payloadBuf.length;

    if (len <= 125) {
      headerBytes = Buffer.from([byte0, (masked ? 0x80 : 0x00) | len]);
    } else if (len <= 65535) {
      headerBytes = Buffer.alloc(4);
      headerBytes[0] = byte0;
      headerBytes[1] = (masked ? 0x80 : 0x00) | 126;
      headerBytes.writeUInt16BE(len, 2);
    } else {
      headerBytes = Buffer.alloc(10);
      headerBytes[0] = byte0;
      headerBytes[1] = (masked ? 0x80 : 0x00) | 127;
      headerBytes.writeBigUInt64BE(BigInt(len), 2);
    }

    if (masked) {
      const maskKey = options.maskKey ?? Buffer.from([0x12, 0x34, 0x56, 0x78]);
      const maskedPayload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) {
        maskedPayload[i] = payloadBuf[i] ^ maskKey[i % 4];
      }
      return Buffer.concat([headerBytes, maskKey, maskedPayload]);
    } else {
      return Buffer.concat([headerBytes, payloadBuf]);
    }
  }

  test('reconstructs and forwards an unmasked text frame', () => {
    const filter = new WebSocketFrameFilter();
    const frame = encodeFrame({ payload: 'hello-world' });

    const result = filter.processChunk(frame);
    expect(result).toHaveLength(1);
    expect(result[0].equals(frame)).toBe(true);
  });

  test('reconstructs and forwards a masked client-to-server frame', () => {
    const filter = new WebSocketFrameFilter();
    const frame = encodeFrame({
      masked: true,
      maskKey: Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]),
      payload: 'masked-client-payload'
    });

    const result = filter.processChunk(frame);
    expect(result).toHaveLength(1);
    expect(result[0].equals(frame)).toBe(true);
  });

  test('handles 16-bit extended payload length (lengthIndicator = 126)', () => {
    const filter = new WebSocketFrameFilter();
    const largeText = 'A'.repeat(500); // > 125 bytes
    const frame = encodeFrame({ payload: largeText });

    const result = filter.processChunk(frame);
    expect(result).toHaveLength(1);
    expect(result[0].equals(frame)).toBe(true);
  });

  test('handles 64-bit extended payload length (lengthIndicator = 127)', () => {
    const filter = new WebSocketFrameFilter();
    const hugePayload = Buffer.alloc(70000, 0x42); // > 65535 bytes
    const frame = encodeFrame({ payload: hugePayload, opcode: 0x2 });

    const result = filter.processChunk(frame);
    expect(result).toHaveLength(1);
    expect(result[0].equals(frame)).toBe(true);
  });

  test('handles multiple frames arriving in a single TCP chunk', () => {
    const filter = new WebSocketFrameFilter();
    const frame1 = encodeFrame({ payload: 'msg-1' });
    const frame2 = encodeFrame({ payload: 'msg-2' });
    const frame3 = encodeFrame({ payload: 'msg-3' });

    const combinedChunk = Buffer.concat([frame1, frame2, frame3]);
    const result = filter.processChunk(combinedChunk);

    expect(result).toHaveLength(3);
    expect(result[0].equals(frame1)).toBe(true);
    expect(result[1].equals(frame2)).toBe(true);
    expect(result[2].equals(frame3)).toBe(true);
  });

  test('handles a single frame split across multiple TCP byte chunks', () => {
    const filter = new WebSocketFrameFilter();
    const frame = encodeFrame({ payload: 'splittable-payload-across-tcp-packets' });

    // Split frame into 3 arbitrary slices
    const chunk1 = frame.subarray(0, 5);
    const chunk2 = frame.subarray(5, 15);
    const chunk3 = frame.subarray(15);

    expect(filter.processChunk(chunk1)).toEqual([]);
    expect(filter.processChunk(chunk2)).toEqual([]);

    const result3 = filter.processChunk(chunk3);
    expect(result3).toHaveLength(1);
    expect(result3[0].equals(frame)).toBe(true);
  });

  test('drops matching frame while forwarding non-matching frames intact', () => {
    const filter = new WebSocketFrameFilter((frame) => {
      return frame.text?.includes('DROP_ME') ?? false;
    });

    const frameKeep1 = encodeFrame({ payload: 'keep-1' });
    const frameDrop = encodeFrame({ payload: 'please-DROP_ME-now' });
    const frameKeep2 = encodeFrame({ payload: 'keep-2' });

    const combined = Buffer.concat([frameKeep1, frameDrop, frameKeep2]);
    const result = filter.processChunk(combined);

    expect(result).toHaveLength(2);
    expect(result[0].equals(frameKeep1)).toBe(true);
    expect(result[1].equals(frameKeep2)).toBe(true);
  });
});
