import { DecodedWebSocketFrame, FrameDropPredicate } from './types.js';

/**
 * WebSocketFrameFilter
 *
 * Implements strict RFC 6455 framing over arbitrary TCP byte streams.
 *
 * TCP is a stream of bytes where a single socket 'data' event may contain:
 * - A partial WebSocket frame fragment
 * - Exactly one WebSocket frame
 * - Multiple WebSocket frames packed together
 *
 * This filter accumulates incoming byte chunks, assembles complete RFC 6455 frames
 * (including 7-bit, 16-bit uint, and 64-bit uint extended payload lengths), and applies
 * an optional drop predicate without corrupting frame boundaries or TCP sequence integrity.
 */
export class WebSocketFrameFilter {
  private buffer: Buffer = Buffer.alloc(0);
  private dropPredicate: FrameDropPredicate | null = null;

  constructor(dropPredicate: FrameDropPredicate | null = null) {
    this.dropPredicate = dropPredicate;
  }

  public setDropPredicate(predicate: FrameDropPredicate | null): void {
    this.dropPredicate = predicate;
  }

  public getDropPredicate(): FrameDropPredicate | null {
    return this.dropPredicate;
  }

  public clear(): void {
    this.buffer = Buffer.alloc(0);
  }

  /**
   * Processes an incoming raw TCP chunk.
   *
   * Assembles complete RFC 6455 frames. If a frame matches the drop predicate,
   * it is omitted from the returned Buffer array. All forwarded frames retain
   * their exact original byte structure (including masks and headers).
   *
   * Any trailing incomplete frame remains buffered for subsequent chunks.
   */
  public processChunk(chunk: Buffer): Buffer[] {
    if (chunk.length === 0) {
      return [];
    }

    this.buffer = Buffer.concat([this.buffer, chunk]);
    const outputChunks: Buffer[] = [];

    while (this.buffer.length >= 2) {
      const byte0 = this.buffer[0];
      const byte1 = this.buffer[1];

      const fin = Boolean(byte0 & 0x80);
      const rsv = (byte0 & 0x70) >> 4;
      const opcode = byte0 & 0x0f;

      const masked = Boolean(byte1 & 0x80);
      const lengthIndicator = byte1 & 0x7f;

      let headerLength = 2;
      let payloadLength = lengthIndicator;

      // Handle extended payload lengths per RFC 6455 Section 5.2
      if (lengthIndicator === 126) {
        if (this.buffer.length < 4) {
          // Need 2 more bytes for 16-bit extended length
          break;
        }
        payloadLength = this.buffer.readUInt16BE(2);
        headerLength = 4;
      } else if (lengthIndicator === 127) {
        if (this.buffer.length < 10) {
          // Need 8 more bytes for 64-bit extended length
          break;
        }
        const bigLen = this.buffer.readBigUInt64BE(2);
        if (bigLen > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error(`WebSocket payload length exceeds MAX_SAFE_INTEGER: ${bigLen}`);
        }
        payloadLength = Number(bigLen);
        headerLength = 10;
      }

      let maskKey: Buffer | undefined;
      if (masked) {
        if (this.buffer.length < headerLength + 4) {
          // Need 4 bytes for masking key
          break;
        }
        maskKey = this.buffer.subarray(headerLength, headerLength + 4);
        headerLength += 4;
      }

      const totalFrameLength = headerLength + payloadLength;
      if (this.buffer.length < totalFrameLength) {
        // Full payload not yet received; wait for next TCP chunk
        break;
      }

      // Complete frame is available
      const rawFrameBytes = this.buffer.subarray(0, totalFrameLength);
      const rawPayload = this.buffer.subarray(headerLength, totalFrameLength);

      // Unmask payload for inspection if masked
      let unmaskedPayload: Buffer;
      if (masked && maskKey) {
        unmaskedPayload = Buffer.allocUnsafe(payloadLength);
        for (let i = 0; i < payloadLength; i++) {
          unmaskedPayload[i] = rawPayload[i] ^ maskKey[i % 4];
        }
      } else {
        unmaskedPayload = rawPayload;
      }

      let text: string | undefined;
      if (opcode === 0x1) {
        try {
          text = unmaskedPayload.toString('utf8');
        } catch {
          // Non-fatal text decode error
        }
      }

      const decodedFrame: DecodedWebSocketFrame = {
        fin,
        rsv,
        opcode,
        masked,
        maskKey,
        payloadLength,
        payload: unmaskedPayload,
        text
      };

      // Check drop predicate
      const shouldDrop = this.dropPredicate ? this.dropPredicate(decodedFrame) : false;

      if (!shouldDrop) {
        // Forward the exact raw frame bytes to preserve client masking and protocol syntax
        outputChunks.push(Buffer.from(rawFrameBytes));
      }

      // Advance buffer past this completed frame
      this.buffer = this.buffer.subarray(totalFrameLength);
    }

    return outputChunks;
  }
}
