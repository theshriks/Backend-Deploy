/**
 * High-Performance WAL Segment
 * Optimized binary format with minimal allocations
 */

import * as fs from 'fs';
import * as path from 'path';
import { crc32 } from './crc32';

const SEGMENT_HEADER_SIZE = 64;
const EVENT_HEADER_SIZE = 28;
const MAGIC = 0x53485257; // "SHRW" - ShrikDB WAL
const VERSION = 2;

// Pre-allocated header buffer for writes
const headerBuffer = Buffer.allocUnsafe(EVENT_HEADER_SIZE);

export interface SegmentInfo {
    id: number;
    path: string;
    startSequence: bigint;
    endSequence: bigint | null;
    size: number;
    eventCount: number;
    sealed: boolean;
}

export class WALSegment {
    private fd: number;
    private offset: number;
    private eventCount = 0;
    private startSequence: bigint;
    private lastSequence: bigint;
    readonly id: number;
    readonly filePath: string;

    private constructor(
        fd: number,
        id: number,
        filePath: string,
        startSequence: bigint,
        offset: number
    ) {
        this.fd = fd;
        this.id = id;
        this.filePath = filePath;
        this.startSequence = startSequence;
        this.lastSequence = startSequence - 1n;
        this.offset = offset;
    }

    /**
     * Create new segment
     */
    static create(dataDir: string, id: number, startSequence: bigint): WALSegment {
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        const fileName = `wal_${String(id).padStart(10, '0')}.seg`;
        const filePath = path.join(dataDir, fileName);
        const fd = fs.openSync(filePath, 'w+');

        // Write header
        const header = Buffer.alloc(SEGMENT_HEADER_SIZE);
        let off = 0;

        header.writeUInt32LE(MAGIC, off); off += 4;
        header.writeUInt32LE(VERSION, off); off += 4;
        header.writeBigUInt64LE(BigInt(id), off); off += 8;
        header.writeBigUInt64LE(startSequence, off); off += 8;
        header.writeBigUInt64LE(0n, off); off += 8; // endSequence (0 = not sealed)
        header.writeBigUInt64LE(0n, off); off += 8; // eventCount
        header.writeBigUInt64LE(BigInt(Date.now()), off); off += 8;
        header.writeBigUInt64LE(0n, off); off += 8; // sealedAt

        fs.writeSync(fd, header, 0, SEGMENT_HEADER_SIZE, 0);

        return new WALSegment(fd, id, filePath, startSequence, SEGMENT_HEADER_SIZE);
    }

    /**
     * Open existing segment
     */
    static open(filePath: string): WALSegment {
        const fd = fs.openSync(filePath, 'r+');
        const header = Buffer.alloc(SEGMENT_HEADER_SIZE);
        fs.readSync(fd, header, 0, SEGMENT_HEADER_SIZE, 0);

        const magic = header.readUInt32LE(0);
        if (magic !== MAGIC) {
            fs.closeSync(fd);
            throw new Error(`Invalid segment magic: ${magic}`);
        }

        const id = Number(header.readBigUInt64LE(8));
        const startSequence = header.readBigUInt64LE(16);
        const stats = fs.fstatSync(fd);

        const segment = new WALSegment(fd, id, filePath, startSequence, stats.size);

        // Scan to find last sequence and event count
        segment.scanToEnd();

        return segment;
    }

    private scanToEnd(): void {
        let offset = SEGMENT_HEADER_SIZE;
        const stats = fs.fstatSync(this.fd);
        const eventHeader = Buffer.alloc(EVENT_HEADER_SIZE);

        while (offset < stats.size) {
            const bytesRead = fs.readSync(this.fd, eventHeader, 0, EVENT_HEADER_SIZE, offset);
            if (bytesRead < EVENT_HEADER_SIZE) break;

            const sequence = eventHeader.readBigUInt64LE(0);
            const payloadLen = eventHeader.readUInt32LE(20);

            this.lastSequence = sequence;
            this.eventCount++;
            offset += EVENT_HEADER_SIZE + payloadLen;
        }

        this.offset = offset;
    }

    /**
     * Write event to segment
     * Returns bytes written
     */
    writeEvent(
        sequence: bigint,
        timestamp: number,
        tenantId: string,
        eventType: string,
        payload: Buffer
    ): number {
        const tenantBuf = Buffer.from(tenantId);
        const typeBuf = Buffer.from(eventType);
        const totalPayload = tenantBuf.length + typeBuf.length + payload.length;

        // Build header
        let off = 0;
        headerBuffer.writeBigUInt64LE(sequence, off); off += 8;
        headerBuffer.writeBigUInt64LE(BigInt(timestamp), off); off += 8;
        headerBuffer.writeUInt8(tenantBuf.length, off); off += 1;
        headerBuffer.writeUInt8(typeBuf.length, off); off += 1;
        headerBuffer.writeUInt16LE(payload.length, off); off += 2;
        headerBuffer.writeUInt32LE(totalPayload, off); off += 4;

        // Calculate checksum
        const checksumData = Buffer.concat([
            headerBuffer.subarray(0, off),
            tenantBuf,
            typeBuf,
            payload
        ]);
        const checksum = crc32(checksumData);
        headerBuffer.writeUInt32LE(checksum, off);

        // Write header
        fs.writeSync(this.fd, headerBuffer, 0, EVENT_HEADER_SIZE, this.offset);
        let written = EVENT_HEADER_SIZE;

        // Write payload parts
        fs.writeSync(this.fd, tenantBuf, 0, tenantBuf.length, this.offset + written);
        written += tenantBuf.length;

        fs.writeSync(this.fd, typeBuf, 0, typeBuf.length, this.offset + written);
        written += typeBuf.length;

        fs.writeSync(this.fd, payload, 0, payload.length, this.offset + written);
        written += payload.length;

        this.offset += written;
        this.eventCount++;
        this.lastSequence = sequence;

        return written;
    }

    /**
     * Write batch of pre-encoded events
     * Much faster than individual writes
     */
    writeBatch(data: Buffer): number {
        fs.writeSync(this.fd, data, 0, data.length, this.offset);
        this.offset += data.length;
        return data.length;
    }

    /**
     * Sync to disk
     */
    sync(): void {
        fs.fsyncSync(this.fd);
    }

    /**
     * Get current size
     */
    getSize(): number {
        return this.offset;
    }

    /**
     * Get event count
     */
    getEventCount(): number {
        return this.eventCount;
    }

    /**
     * Get last sequence
     */
    getLastSequence(): bigint {
        return this.lastSequence;
    }

    /**
     * Seal segment (mark as read-only)
     */
    seal(): SegmentInfo {
        const header = Buffer.alloc(SEGMENT_HEADER_SIZE);
        fs.readSync(this.fd, header, 0, SEGMENT_HEADER_SIZE, 0);

        // Update header
        header.writeBigUInt64LE(this.lastSequence, 24); // endSequence
        header.writeBigUInt64LE(BigInt(this.eventCount), 32); // eventCount
        header.writeBigUInt64LE(BigInt(Date.now()), 48); // sealedAt

        fs.writeSync(this.fd, header, 0, SEGMENT_HEADER_SIZE, 0);
        fs.fsyncSync(this.fd);
        fs.closeSync(this.fd);

        return {
            id: this.id,
            path: this.filePath,
            startSequence: this.startSequence,
            endSequence: this.lastSequence,
            size: this.offset,
            eventCount: this.eventCount,
            sealed: true
        };
    }

    /**
     * Close without sealing
     */
    close(): void {
        fs.fsyncSync(this.fd);
        fs.closeSync(this.fd);
    }

    /**
     * Read events from segment
     */
    *readEvents(fromOffset = SEGMENT_HEADER_SIZE): Generator<{
        sequence: bigint;
        timestamp: number;
        tenantId: string;
        eventType: string;
        payload: Buffer;
        checksum: number;
    }> {
        let offset = fromOffset;
        const eventHeader = Buffer.alloc(EVENT_HEADER_SIZE);

        while (offset < this.offset) {
            const bytesRead = fs.readSync(this.fd, eventHeader, 0, EVENT_HEADER_SIZE, offset);
            if (bytesRead < EVENT_HEADER_SIZE) break;

            const sequence = eventHeader.readBigUInt64LE(0);
            const timestamp = Number(eventHeader.readBigUInt64LE(8));
            const tenantLen = eventHeader.readUInt8(16);
            const typeLen = eventHeader.readUInt8(17);
            const payloadLen = eventHeader.readUInt16LE(18);
            const totalLen = eventHeader.readUInt32LE(20);
            const checksum = eventHeader.readUInt32LE(24);

            // Read payload
            const payloadBuf = Buffer.alloc(totalLen);
            fs.readSync(this.fd, payloadBuf, 0, totalLen, offset + EVENT_HEADER_SIZE);

            const tenantId = payloadBuf.subarray(0, tenantLen).toString();
            const eventType = payloadBuf.subarray(tenantLen, tenantLen + typeLen).toString();
            const payload = payloadBuf.subarray(tenantLen + typeLen);

            yield { sequence, timestamp, tenantId, eventType, payload, checksum };

            offset += EVENT_HEADER_SIZE + totalLen;
        }
    }
}

/**
 * List segment files
 */
export function listSegments(dataDir: string): string[] {
    if (!fs.existsSync(dataDir)) return [];

    return fs.readdirSync(dataDir)
        .filter(f => f.startsWith('wal_') && f.endsWith('.seg'))
        .sort()
        .map(f => path.join(dataDir, f));
}
