import crypto from 'crypto';

/**
 * Pulse — Monotonic Time-Sortable UUIDv7 Implementation
 * Conforms to RFC 9562 (Section 5.7)
 *
 * Layout:
 * 0                   1                   2                   3
 * 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |                           unix_ts_ms                          |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |          unix_ts_ms           |  ver  |       seq / rand      |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |var|                         rand_b                            |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |                            rand_b                             |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 */

let lastMs = 0;
let sequenceCounter = 0;

/**
 * Generates a monotonic, time-sortable UUIDv7 string.
 *
 * @param customTimestamp Optional epoch timestamp in milliseconds (defaults to Date.now())
 */
export function generateUUIDv7(customTimestamp?: number): string {
  let ms = customTimestamp !== undefined ? customTimestamp : Date.now();

  // Monotonic sequence handling within the same millisecond
  if (customTimestamp === undefined) {
    if (ms > lastMs) {
      lastMs = ms;
      sequenceCounter = crypto.randomInt(0, 0x3ff); // seed with 10-bit random
    } else if (ms === lastMs) {
      sequenceCounter++;
      if (sequenceCounter > 0xfff) {
        // Rollover safety: wait/advance millisecond
        ms++;
        lastMs = ms;
        sequenceCounter = 0;
      }
    } else {
      // Clock moved backwards: preserve monotonicity
      ms = lastMs;
      sequenceCounter++;
    }
  } else {
    sequenceCounter = crypto.randomInt(0, 0xfff);
  }

  const bytes = Buffer.alloc(16);

  // 48-bit timestamp (bytes 0-5)
  bytes.writeUIntBE(ms, 0, 6);

  // 4-bit version (0b0111 = 7) + top 12 bits sequence/rand (bytes 6-7)
  const verAndSeq = (0x7 << 12) | (sequenceCounter & 0xfff);
  bytes.writeUInt16BE(verAndSeq, 6);

  // 2-bit variant (0b10) + remaining 62 bits random entropy (bytes 8-15)
  crypto.randomFillSync(bytes, 8, 8);
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // set RFC 4122/9562 variant (0b10xxxxxx)

  // Format into 8-4-4-4-12 hex string
  const hex = bytes.toString('hex');
  return [
    hex.substring(0, 8),
    hex.substring(8, 12),
    hex.substring(12, 16),
    hex.substring(16, 20),
    hex.substring(20, 32)
  ].join('-');
}

const UUIDV7_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates whether a string is a formally compliant UUIDv7.
 */
export function isValidUUIDv7(id: string): boolean {
  if (typeof id !== 'string' || id.length !== 36) {
    return false;
  }
  return UUIDV7_REGEX.test(id);
}

/**
 * Extracts the 48-bit Unix epoch millisecond timestamp embedded in a UUIDv7.
 */
export function extractTimestampFromUUIDv7(id: string): number {
  if (!isValidUUIDv7(id)) {
    throw new Error(`Invalid UUIDv7 identifier: ${id}`);
  }
  const cleanHex = id.replace(/-/g, '').substring(0, 12);
  return parseInt(cleanHex, 16);
}
