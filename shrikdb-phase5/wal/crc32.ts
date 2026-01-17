/**
 * CRC32 Implementation for WAL Checksums
 * Pure TypeScript implementation - no external dependencies
 */

// CRC32 lookup table (IEEE polynomial)
const CRC32_TABLE: number[] = (() => {
    const table: number[] = new Array(256);
    for (let i = 0; i < 256; i++) {
        let crc = i;
        for (let j = 0; j < 8; j++) {
            crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
        }
        table[i] = crc >>> 0;
    }
    return table;
})();

/**
 * Calculate CRC32 checksum of a buffer
 */
export function crc32(data: Buffer): number {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
        crc = CRC32_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Calculate CRC32 checksum of a string
 */
export function crc32String(str: string): number {
    return crc32(Buffer.from(str, 'utf-8'));
}

/**
 * Verify CRC32 checksum
 */
export function verifyCrc32(data: Buffer, expectedChecksum: number): boolean {
    return crc32(data) === expectedChecksum;
}

/**
 * Combine multiple CRC32 checksums (for segment-level checksums)
 */
export function combineCrc32(checksums: number[]): number {
    if (checksums.length === 0) return 0;
    let combined = checksums[0];
    for (let i = 1; i < checksums.length; i++) {
        combined = combined ^ checksums[i];
    }
    return combined >>> 0;
}
