import {
  generateUUIDv7,
  isValidUUIDv7,
  extractTimestampFromUUIDv7
} from '../../src/utils/uuidv7';

describe('UUIDv7 Generator & Validator (Phase 2)', () => {
  it('generates a valid UUIDv7 format', () => {
    const id = generateUUIDv7();
    expect(id).toHaveLength(36);
    expect(isValidUUIDv7(id)).toBe(true);

    // Verify 13th char is '7' (version)
    expect(id.charAt(14)).toBe('7');

    // Verify variant char is '8', '9', 'a', or 'b'
    const variantChar = id.charAt(19).toLowerCase();
    expect(['8', '9', 'a', 'b']).toContain(variantChar);
  });

  it('embeds accurate millisecond timestamp', () => {
    const before = Date.now();
    const id = generateUUIDv7();
    const after = Date.now();

    const extracted = extractTimestampFromUUIDv7(id);
    expect(extracted).toBeGreaterThanOrEqual(before);
    expect(extracted).toBeLessThanOrEqual(after);
  });

  it('embeds custom timestamp accurately', () => {
    const customTime = 1715000000000;
    const id = generateUUIDv7(customTime);

    expect(isValidUUIDv7(id)).toBe(true);
    expect(extractTimestampFromUUIDv7(id)).toBe(customTime);
  });

  it('preserves monotonic ordering across sequential generations', () => {
    const count = 200;
    const ids: string[] = [];

    for (let i = 0; i < count; i++) {
      ids.push(generateUUIDv7());
    }

    for (let i = 0; i < count - 1; i++) {
      // String comparison must be strictly monotonic: ids[i] < ids[i+1]
      expect(ids[i] < ids[i + 1]).toBe(true);
    }
  });

  it('rejects invalid or non-v7 UUIDs', () => {
    expect(isValidUUIDv7('')).toBe(false);
    expect(isValidUUIDv7('not-a-uuid')).toBe(false);
    expect(isValidUUIDv7('12345678-1234-1234-1234-123456789012')).toBe(false);

    // Standard UUIDv4 (version 4 instead of 7)
    const uuidv4 = 'c7a8b3e1-4567-4f8a-9e12-3456789abcde';
    expect(isValidUUIDv7(uuidv4)).toBe(false);

    // Extraction should throw on invalid ID
    expect(() => extractTimestampFromUUIDv7(uuidv4)).toThrow(/Invalid UUIDv7/);
  });
});
