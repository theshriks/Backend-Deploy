/**
 * High-Performance CRC32 with lookup table
 * Optimized for throughput - single pass, no allocations
 */

const CRC32_TABLE = new Uint32Array(256);

// Initialize lookup table once
(function initCRC32Table() {
    for (let i = 0; i < 256; i++) {
        let crc = i;
        for (let j = 0; j < 8; j++) {
            crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
        }
        CRC32_TABLE[i] = crc >>> 0;
    }
})();

/**
 * Fast CRC32 calculation
 * Uses pre-computed lookup table for speed
 */
export function crc32(data: Buffer): number {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
        crc = CRC32_TABLE[(crc ^ data[i]) & 0xFF]! ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Incremental CRC32 for streaming
 */
export class CRC32Stream {
    private crc = 0xFFFFFFFF;

    update(data: Buffer): void {
        for (let i = 0; i < data.length; i++) {
            this.crc = CRC32_TABLE[(this.crc ^ data[i]) & 0xFF]! ^ (this.crc >>> 8);
        }
    }

    digest(): number {
        return (this.crc ^ 0xFFFFFFFF) >>> 0;
    }

    reset(): void {
        this.crc = 0xFFFFFFFF;
    }
}
