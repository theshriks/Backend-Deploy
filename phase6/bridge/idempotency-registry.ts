/**
 * Idempotency Registry
 * 
 * Crash-safe registry that tracks which events have been delivered to WAL.
 * Prevents duplicate delivery through exactly-once semantics.
 * 
 * STORAGE FORMAT:
 * - Append-only log file: idempotency.log
 * - Each entry: [velocitySeq:8][walSeq:8][streamIdLen:2][streamId:N][timestamp:8][checksum:4]
 * - Periodic compaction removes old entries
 * 
 * GUARANTEES:
 * - Survives crashes without losing delivered event records
 * - Fast lookup for deduplication
 * - Periodic compaction keeps file size manageable
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    IIdempotencyRegistry,
    IdempotencyKey,
    DeliveryReceipt,
    BridgeError,
    BridgeErrorCode
} from '../contracts/types';
import { crc32 } from '../utils/crc32';

const ENTRY_HEADER_SIZE = 26; // 8 + 8 + 2 + 8 = 26 bytes before streamId
const MAGIC = 0x49444D50; // "IDMP"

interface RegistryEntry {
    velocitySeq: bigint;
    walSequence: bigint;
    streamId: string;
    deliveredAt: number;
    checksum: number;
}

export class IdempotencyRegistry implements IIdempotencyRegistry {
    private readonly dataDir: string;
    private readonly logPath: string;
    private fd: number | null = null;

    // In-memory index for fast lookups
    // Key: `${streamId}:${velocitySeq}`
    private index: Map<string, DeliveryReceipt> = new Map();

    // Metrics
    private entryCount = 0;
    private recoveredCount = 0;

    constructor(dataDir: string) {
        this.dataDir = dataDir;
        this.logPath = path.join(dataDir, 'idempotency.log');
    }

    /**
     * Initialize the registry.
     */
    async initialize(): Promise<void> {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }

        if (fs.existsSync(this.logPath)) {
            // Recover existing entries
            await this.recover();
        }

        // Open for append
        this.fd = fs.openSync(this.logPath, 'a');
    }

    /**
     * Check if an event was already delivered.
     */
    isDelivered(key: IdempotencyKey): boolean {
        const indexKey = this.makeIndexKey(key.streamId, key.velocitySeq);
        return this.index.has(indexKey);
    }

    /**
     * Mark an event as delivered.
     * This persists the receipt to disk before returning.
     */
    async markDelivered(receipt: DeliveryReceipt): Promise<void> {
        const indexKey = this.makeIndexKey(receipt.streamId, receipt.velocitySeq);

        // Check for duplicate
        if (this.index.has(indexKey)) {
            throw new BridgeError(
                `Event already delivered: stream=${receipt.streamId}, seq=${receipt.velocitySeq}`,
                BridgeErrorCode.DUPLICATE_EVENT,
                false
            );
        }

        // Persist to disk first (crash safety)
        await this.persistEntry(receipt);

        // Update in-memory index
        this.index.set(indexKey, receipt);
        this.entryCount++;
    }

    /**
     * Get the receipt for a delivered event.
     */
    getReceipt(key: IdempotencyKey): DeliveryReceipt | null {
        const indexKey = this.makeIndexKey(key.streamId, key.velocitySeq);
        return this.index.get(indexKey) ?? null;
    }

    /**
     * Recover state from the log file.
     */
    async recover(): Promise<void> {
        if (!fs.existsSync(this.logPath)) {
            return;
        }

        const fd = fs.openSync(this.logPath, 'r');
        const stats = fs.fstatSync(fd);
        let offset = 0;
        const headerBuf = Buffer.alloc(ENTRY_HEADER_SIZE);

        while (offset < stats.size) {
            // Read header
            const bytesRead = fs.readSync(fd, headerBuf, 0, ENTRY_HEADER_SIZE, offset);
            if (bytesRead < ENTRY_HEADER_SIZE) {
                break; // Incomplete entry (possible crash during write)
            }

            // Parse header
            const velocitySeq = headerBuf.readBigUInt64LE(0);
            const walSequence = headerBuf.readBigUInt64LE(8);
            const streamIdLen = headerBuf.readUInt16LE(16);
            const deliveredAt = Number(headerBuf.readBigUInt64LE(18));

            // Read stream ID
            const streamIdBuf = Buffer.alloc(streamIdLen);
            const streamRead = fs.readSync(fd, streamIdBuf, 0, streamIdLen, offset + ENTRY_HEADER_SIZE);
            if (streamRead < streamIdLen) {
                break; // Incomplete entry
            }
            const streamId = streamIdBuf.toString('utf-8');

            // Read checksum
            const checksumBuf = Buffer.alloc(4);
            const checksumRead = fs.readSync(fd, checksumBuf, 0, 4, offset + ENTRY_HEADER_SIZE + streamIdLen);
            if (checksumRead < 4) {
                break; // Incomplete entry
            }
            const storedChecksum = checksumBuf.readUInt32LE(0);

            // Verify checksum
            const dataToCheck = Buffer.concat([
                headerBuf,
                streamIdBuf
            ]);
            const calculatedChecksum = crc32(dataToCheck);

            if (calculatedChecksum !== storedChecksum) {
                console.warn(`Checksum mismatch at offset ${offset}, skipping entry`);
                // Try to continue reading
                offset += ENTRY_HEADER_SIZE + streamIdLen + 4;
                continue;
            }

            // Add to index
            const receipt: DeliveryReceipt = {
                velocitySeq,
                walSequence,
                streamId,
                deliveredAt,
                checksum: storedChecksum
            };

            const indexKey = this.makeIndexKey(streamId, velocitySeq);
            this.index.set(indexKey, receipt);
            this.recoveredCount++;

            offset += ENTRY_HEADER_SIZE + streamIdLen + 4;
        }

        fs.closeSync(fd);
        this.entryCount = this.recoveredCount;
    }

    /**
     * Force sync all pending writes to disk.
     */
    async flush(): Promise<void> {
        if (this.fd) {
            fs.fsyncSync(this.fd);
        }
    }

    /**
     * Close the registry.
     */
    async close(): Promise<void> {
        if (this.fd) {
            fs.fsyncSync(this.fd);
            fs.closeSync(this.fd);
            this.fd = null;
        }
    }

    /**
     * Get metrics.
     */
    getMetrics(): { entryCount: number; recoveredCount: number } {
        return {
            entryCount: this.entryCount,
            recoveredCount: this.recoveredCount
        };
    }

    /**
     * Get all delivered sequences for a stream.
     */
    getDeliveredForStream(streamId: string): bigint[] {
        const sequences: bigint[] = [];
        const prefix = `${streamId}:`;

        for (const key of this.index.keys()) {
            if (key.startsWith(prefix)) {
                const seq = BigInt(key.slice(prefix.length));
                sequences.push(seq);
            }
        }

        return sequences.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }

    /**
     * Persist entry to disk.
     */
    private async persistEntry(receipt: DeliveryReceipt): Promise<void> {
        if (!this.fd) {
            throw new BridgeError(
                'Registry not initialized',
                BridgeErrorCode.NOT_INITIALIZED,
                false
            );
        }

        const streamIdBuf = Buffer.from(receipt.streamId, 'utf-8');
        const entrySize = ENTRY_HEADER_SIZE + streamIdBuf.length + 4;
        const entryBuf = Buffer.alloc(entrySize);

        let offset = 0;

        // Write header
        entryBuf.writeBigUInt64LE(receipt.velocitySeq, offset); offset += 8;
        entryBuf.writeBigUInt64LE(receipt.walSequence, offset); offset += 8;
        entryBuf.writeUInt16LE(streamIdBuf.length, offset); offset += 2;
        entryBuf.writeBigUInt64LE(BigInt(receipt.deliveredAt), offset); offset += 8;

        // Write stream ID
        streamIdBuf.copy(entryBuf, offset); offset += streamIdBuf.length;

        // Calculate and write checksum
        const dataToCheck = entryBuf.subarray(0, offset);
        const checksum = crc32(dataToCheck);
        entryBuf.writeUInt32LE(checksum, offset);

        // Write to disk
        fs.writeSync(this.fd, entryBuf);

        // Sync to ensure durability
        fs.fsyncSync(this.fd);
    }

    private makeIndexKey(streamId: string, velocitySeq: bigint): string {
        return `${streamId}:${velocitySeq}`;
    }

    /**
     * Compact the log by removing duplicate entries.
     * Should be called periodically during low activity.
     */
    async compact(): Promise<{ entriesBefore: number; entriesAfter: number }> {
        const entriesBefore = this.entryCount;

        // Close current file
        await this.close();

        // Write all current entries to new file
        const tempPath = this.logPath + '.tmp';
        const tempFd = fs.openSync(tempPath, 'w');

        for (const receipt of this.index.values()) {
            const streamIdBuf = Buffer.from(receipt.streamId, 'utf-8');
            const entrySize = ENTRY_HEADER_SIZE + streamIdBuf.length + 4;
            const entryBuf = Buffer.alloc(entrySize);

            let offset = 0;
            entryBuf.writeBigUInt64LE(receipt.velocitySeq, offset); offset += 8;
            entryBuf.writeBigUInt64LE(receipt.walSequence, offset); offset += 8;
            entryBuf.writeUInt16LE(streamIdBuf.length, offset); offset += 2;
            entryBuf.writeBigUInt64LE(BigInt(receipt.deliveredAt), offset); offset += 8;
            streamIdBuf.copy(entryBuf, offset); offset += streamIdBuf.length;

            const dataToCheck = entryBuf.subarray(0, offset);
            const checksum = crc32(dataToCheck);
            entryBuf.writeUInt32LE(checksum, offset);

            fs.writeSync(tempFd, entryBuf);
        }

        fs.fsyncSync(tempFd);
        fs.closeSync(tempFd);

        // Replace old file
        fs.renameSync(tempPath, this.logPath);

        // Reopen
        this.fd = fs.openSync(this.logPath, 'a');

        return {
            entriesBefore,
            entriesAfter: this.index.size
        };
    }
}
