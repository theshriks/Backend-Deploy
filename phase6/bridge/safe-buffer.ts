/**
 * Safe Buffer
 * 
 * Crash-safe buffer for pending events awaiting delivery to WAL.
 * Events are persisted before acknowledgment to prevent data loss.
 * 
 * STORAGE FORMAT:
 * - Write-ahead log: buffer.wal
 * - Each entry: [magic:4][velocitySeq:8][streamIdLen:2][streamId:N][tenantIdLen:2][tenantId:N]
 *               [eventTypeLen:2][eventType:N][payloadLen:4][payload:N][timestamp:8][checksum:4]
 * - Tombstone entries: [TOMB:4][velocitySeq:8][streamIdLen:2][streamId:N]
 * 
 * GUARANTEES:
 * - Events survive crashes while pending
 * - Acknowledging an event removes it from pending
 * - Recovery replays pending events in order
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    VelocityEvent,
    ISafeBuffer,
    BridgeError,
    BridgeErrorCode
} from '../contracts/types';
import { crc32 } from '../utils/crc32';

const MAGIC_EVENT = 0x45564E54; // "EVNT"
const MAGIC_TOMBSTONE = 0x544F4D42; // "TOMB"
const ENTRY_HEADER_SIZE = 4; // Just magic

interface BufferEntry {
    event: VelocityEvent;
    offset: number;
    acknowledged: boolean;
}

export class SafeBuffer implements ISafeBuffer {
    private readonly dataDir: string;
    private readonly walPath: string;
    private fd: number | null = null;
    private offset = 0;

    // In-memory index
    // Key: `${streamId}:${velocitySeq}`
    private pending: Map<string, BufferEntry> = new Map();
    private acknowledged: Set<string> = new Set();

    // Metrics
    private totalPushed = 0;
    private totalAcknowledged = 0;

    constructor(dataDir: string) {
        this.dataDir = dataDir;
        this.walPath = path.join(dataDir, 'buffer.wal');
    }

    /**
     * Initialize the buffer.
     */
    async initialize(): Promise<void> {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }

        if (fs.existsSync(this.walPath)) {
            // Recover existing entries
            await this.recover();
        }

        // Open for append
        this.fd = fs.openSync(this.walPath, 'a');
        this.offset = fs.fstatSync(this.fd).size;
    }

    /**
     * Add event to buffer.
     * Event is persisted before returning.
     */
    async push(event: VelocityEvent): Promise<void> {
        if (!this.fd) {
            throw new BridgeError(
                'Buffer not initialized',
                BridgeErrorCode.NOT_INITIALIZED,
                false
            );
        }

        const key = this.makeKey(event.streamId, event.velocitySeq);

        // Check if already pending
        if (this.pending.has(key)) {
            return; // Already in buffer
        }

        // Persist to disk first
        const entryOffset = this.offset;
        await this.persistEvent(event);

        // Add to in-memory index
        this.pending.set(key, {
            event,
            offset: entryOffset,
            acknowledged: false
        });

        this.totalPushed++;
    }

    /**
     * Mark event as delivered (acknowledged).
     * Writes tombstone but doesn't remove from file (compaction handles that).
     */
    async acknowledge(velocitySeq: bigint, streamId: string): Promise<void> {
        if (!this.fd) {
            throw new BridgeError(
                'Buffer not initialized',
                BridgeErrorCode.NOT_INITIALIZED,
                false
            );
        }

        const key = this.makeKey(streamId, velocitySeq);

        if (!this.pending.has(key)) {
            return; // Already acknowledged or never added
        }

        // Write tombstone first
        await this.persistTombstone(velocitySeq, streamId);

        // Update in-memory state
        const entry = this.pending.get(key)!;
        entry.acknowledged = true;
        this.pending.delete(key);
        this.acknowledged.add(key);

        this.totalAcknowledged++;
    }

    /**
     * Get all pending events (not yet acknowledged).
     */
    async *getPending(): AsyncGenerator<VelocityEvent> {
        // Sort by velocity sequence for ordering
        const entries = Array.from(this.pending.values())
            .filter(e => !e.acknowledged)
            .sort((a, b) => {
                if (a.event.streamId !== b.event.streamId) {
                    return a.event.streamId.localeCompare(b.event.streamId);
                }
                return a.event.velocitySeq < b.event.velocitySeq ? -1 :
                    a.event.velocitySeq > b.event.velocitySeq ? 1 : 0;
            });

        for (const entry of entries) {
            yield entry.event;
        }
    }

    /**
     * Current buffer size (pending count).
     */
    size(): number {
        return this.pending.size;
    }

    /**
     * Recover pending events from disk.
     * Returns count of recovered entries.
     */
    async recover(): Promise<number> {
        if (!fs.existsSync(this.walPath)) {
            return 0;
        }

        const fd = fs.openSync(this.walPath, 'r');
        const stats = fs.fstatSync(fd);
        let offset = 0;
        let recovered = 0;

        while (offset < stats.size) {
            // Read magic
            const magicBuf = Buffer.alloc(4);
            const magicRead = fs.readSync(fd, magicBuf, 0, 4, offset);
            if (magicRead < 4) break;

            const magic = magicBuf.readUInt32LE(0);

            if (magic === MAGIC_EVENT) {
                // Parse event entry
                const result = this.readEventEntry(fd, offset);
                if (!result) break;

                const key = this.makeKey(result.event.streamId, result.event.velocitySeq);

                // Only add if not tombstoned
                if (!this.acknowledged.has(key)) {
                    this.pending.set(key, {
                        event: result.event,
                        offset,
                        acknowledged: false
                    });
                    recovered++;
                }

                offset = result.nextOffset;
            } else if (magic === MAGIC_TOMBSTONE) {
                // Parse tombstone
                const result = this.readTombstoneEntry(fd, offset);
                if (!result) break;

                const key = this.makeKey(result.streamId, result.velocitySeq);
                this.acknowledged.add(key);
                this.pending.delete(key);

                offset = result.nextOffset;
            } else {
                // Unknown magic - try to skip
                console.warn(`Unknown magic ${magic} at offset ${offset}`);
                offset += 4;
            }
        }

        fs.closeSync(fd);
        return recovered;
    }

    /**
     * Close the buffer.
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
    getMetrics(): { totalPushed: number; totalAcknowledged: number; pending: number } {
        return {
            totalPushed: this.totalPushed,
            totalAcknowledged: this.totalAcknowledged,
            pending: this.pending.size
        };
    }

    /**
     * Compact the buffer by removing tombstoned entries.
     */
    async compact(): Promise<{ entriesBefore: number; entriesAfter: number }> {
        const entriesBefore = this.totalPushed;

        // Close current file
        await this.close();

        // Write all pending entries to new file
        const tempPath = this.walPath + '.tmp';
        const tempFd = fs.openSync(tempPath, 'w');

        for (const entry of this.pending.values()) {
            if (!entry.acknowledged) {
                this.persistEventToFd(tempFd, entry.event);
            }
        }

        fs.fsyncSync(tempFd);
        fs.closeSync(tempFd);

        // Replace old file
        fs.renameSync(tempPath, this.walPath);

        // Clear acknowledged set
        this.acknowledged.clear();

        // Reopen
        this.fd = fs.openSync(this.walPath, 'a');
        this.offset = fs.fstatSync(this.fd).size;

        return {
            entriesBefore,
            entriesAfter: this.pending.size
        };
    }

    /**
     * Persist event to disk.
     */
    private async persistEvent(event: VelocityEvent): Promise<void> {
        if (!this.fd) return;

        const bytesWritten = this.persistEventToFd(this.fd, event);
        fs.fsyncSync(this.fd);
        this.offset += bytesWritten;
    }

    private persistEventToFd(fd: number, event: VelocityEvent): number {
        const streamIdBuf = Buffer.from(event.streamId, 'utf-8');
        const tenantIdBuf = Buffer.from(event.tenantId, 'utf-8');
        const eventTypeBuf = Buffer.from(event.eventType, 'utf-8');
        const payloadBuf = Buffer.from(JSON.stringify(event.payload), 'utf-8');

        const totalSize = 4 + // magic
            8 + // velocitySeq
            2 + streamIdBuf.length + // streamId
            2 + tenantIdBuf.length + // tenantId
            2 + eventTypeBuf.length + // eventType
            4 + payloadBuf.length + // payload
            8 + // timestamp
            1 + // irreversibilityMarker
            4; // checksum

        const buf = Buffer.alloc(totalSize);
        let off = 0;

        buf.writeUInt32LE(MAGIC_EVENT, off); off += 4;
        buf.writeBigUInt64LE(event.velocitySeq, off); off += 8;
        buf.writeUInt16LE(streamIdBuf.length, off); off += 2;
        streamIdBuf.copy(buf, off); off += streamIdBuf.length;
        buf.writeUInt16LE(tenantIdBuf.length, off); off += 2;
        tenantIdBuf.copy(buf, off); off += tenantIdBuf.length;
        buf.writeUInt16LE(eventTypeBuf.length, off); off += 2;
        eventTypeBuf.copy(buf, off); off += eventTypeBuf.length;
        buf.writeUInt32LE(payloadBuf.length, off); off += 4;
        payloadBuf.copy(buf, off); off += payloadBuf.length;
        buf.writeBigUInt64LE(BigInt(event.timestamp), off); off += 8;
        buf.writeUInt8(event.irreversibilityMarker ? 1 : 0, off); off += 1;

        // Calculate checksum of everything before it
        const dataToCheck = buf.subarray(0, off);
        const checksum = crc32(dataToCheck);
        buf.writeUInt32LE(checksum, off);

        fs.writeSync(fd, buf);
        return totalSize;
    }

    /**
     * Persist tombstone to disk.
     */
    private async persistTombstone(velocitySeq: bigint, streamId: string): Promise<void> {
        if (!this.fd) return;

        const streamIdBuf = Buffer.from(streamId, 'utf-8');
        const totalSize = 4 + 8 + 2 + streamIdBuf.length;
        const buf = Buffer.alloc(totalSize);

        let off = 0;
        buf.writeUInt32LE(MAGIC_TOMBSTONE, off); off += 4;
        buf.writeBigUInt64LE(velocitySeq, off); off += 8;
        buf.writeUInt16LE(streamIdBuf.length, off); off += 2;
        streamIdBuf.copy(buf, off);

        fs.writeSync(this.fd, buf);
        fs.fsyncSync(this.fd);
        this.offset += totalSize;
    }

    /**
     * Read event entry from file.
     */
    private readEventEntry(fd: number, offset: number): { event: VelocityEvent; nextOffset: number } | null {
        // Skip magic (already read)
        let off = offset + 4;

        const seqBuf = Buffer.alloc(8);
        if (fs.readSync(fd, seqBuf, 0, 8, off) < 8) return null;
        const velocitySeq = seqBuf.readBigUInt64LE(0);
        off += 8;

        // Stream ID
        const streamIdLenBuf = Buffer.alloc(2);
        if (fs.readSync(fd, streamIdLenBuf, 0, 2, off) < 2) return null;
        const streamIdLen = streamIdLenBuf.readUInt16LE(0);
        off += 2;

        const streamIdBuf = Buffer.alloc(streamIdLen);
        if (fs.readSync(fd, streamIdBuf, 0, streamIdLen, off) < streamIdLen) return null;
        const streamId = streamIdBuf.toString('utf-8');
        off += streamIdLen;

        // Tenant ID
        const tenantIdLenBuf = Buffer.alloc(2);
        if (fs.readSync(fd, tenantIdLenBuf, 0, 2, off) < 2) return null;
        const tenantIdLen = tenantIdLenBuf.readUInt16LE(0);
        off += 2;

        const tenantIdBuf = Buffer.alloc(tenantIdLen);
        if (fs.readSync(fd, tenantIdBuf, 0, tenantIdLen, off) < tenantIdLen) return null;
        const tenantId = tenantIdBuf.toString('utf-8');
        off += tenantIdLen;

        // Event Type
        const eventTypeLenBuf = Buffer.alloc(2);
        if (fs.readSync(fd, eventTypeLenBuf, 0, 2, off) < 2) return null;
        const eventTypeLen = eventTypeLenBuf.readUInt16LE(0);
        off += 2;

        const eventTypeBuf = Buffer.alloc(eventTypeLen);
        if (fs.readSync(fd, eventTypeBuf, 0, eventTypeLen, off) < eventTypeLen) return null;
        const eventType = eventTypeBuf.toString('utf-8');
        off += eventTypeLen;

        // Payload
        const payloadLenBuf = Buffer.alloc(4);
        if (fs.readSync(fd, payloadLenBuf, 0, 4, off) < 4) return null;
        const payloadLen = payloadLenBuf.readUInt32LE(0);
        off += 4;

        const payloadBuf = Buffer.alloc(payloadLen);
        if (fs.readSync(fd, payloadBuf, 0, payloadLen, off) < payloadLen) return null;
        const payload = JSON.parse(payloadBuf.toString('utf-8'));
        off += payloadLen;

        // Timestamp
        const timestampBuf = Buffer.alloc(8);
        if (fs.readSync(fd, timestampBuf, 0, 8, off) < 8) return null;
        const timestamp = Number(timestampBuf.readBigUInt64LE(0));
        off += 8;

        // Irreversibility marker
        const markerBuf = Buffer.alloc(1);
        if (fs.readSync(fd, markerBuf, 0, 1, off) < 1) return null;
        const irreversibilityMarker = markerBuf.readUInt8(0) === 1;
        off += 1;

        // Checksum (skip validation for now)
        off += 4;

        return {
            event: {
                velocitySeq,
                streamId,
                tenantId,
                eventType,
                payload,
                timestamp,
                irreversibilityMarker
            },
            nextOffset: off
        };
    }

    /**
     * Read tombstone entry from file.
     */
    private readTombstoneEntry(fd: number, offset: number): { velocitySeq: bigint; streamId: string; nextOffset: number } | null {
        // Skip magic
        let off = offset + 4;

        const seqBuf = Buffer.alloc(8);
        if (fs.readSync(fd, seqBuf, 0, 8, off) < 8) return null;
        const velocitySeq = seqBuf.readBigUInt64LE(0);
        off += 8;

        const streamIdLenBuf = Buffer.alloc(2);
        if (fs.readSync(fd, streamIdLenBuf, 0, 2, off) < 2) return null;
        const streamIdLen = streamIdLenBuf.readUInt16LE(0);
        off += 2;

        const streamIdBuf = Buffer.alloc(streamIdLen);
        if (fs.readSync(fd, streamIdBuf, 0, streamIdLen, off) < streamIdLen) return null;
        const streamId = streamIdBuf.toString('utf-8');
        off += streamIdLen;

        return { velocitySeq, streamId, nextOffset: off };
    }

    private makeKey(streamId: string, velocitySeq: bigint): string {
        return `${streamId}:${velocitySeq}`;
    }
}
