/**
 * CRC32 Checksum Implementation
 * Used for integrity verification throughout the Truth Bridge.
 */

const CRC32_TABLE = new Uint32Array(256);

// Initialize lookup table
for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
        crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    CRC32_TABLE[i] = crc;
}

/**
 * Calculate CRC32 checksum of a buffer.
 */
export function crc32(data: Buffer): number {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
        crc = CRC32_TABLE[(crc ^ data[i]!) & 0xFF]! ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Verify CRC32 checksum matches.
 */
export function verifyCrc32(data: Buffer, expected: number): boolean {
    return crc32(data) === expected;
}
