/**
 * Ultra High-Performance WAL Engine
 * Optimized for maximum throughput while maintaining durability guarantees
 */

import * as fs from 'fs';
import * as path from 'path';
import { WALConfig, WALEventInput, WALAppendResult, SyncMode } from '../contracts/types';
import { crc32 } from './crc32';

const SEGMENT_HEADER_SIZE = 64;
const EVENT_HEADER_SIZE = 28;
const MAGIC = 0x53485257;

// Pre-allocated buffers for speed
const headerBuf = Buffer.allocUnsafe(EVENT_HEADER_SIZE);
const segmentHeaderBuf = Buffer.allocUnsafe(SEGMENT_HEADER_SIZE);

interface PendingEvent {
    tenantId: string;
    eventType: string;
    payload: Buffer;
    resolve: (result: WALAppendResult) => void;
    reject: (error: Error) => void;
    enqueuedAt: number;
}

export class UltraFastWAL {
    private dataDir: string;
    private fd: number | null = null;
    private filePath: string = '';
    private segmentId = 0;
    private offset = SEGMENT_HEADER_SIZE;
    private sequence = 1n;
    private initialized = false;

    // Batching
    private pending: PendingEvent[] = [];
    private writeBuffer: Buffer;
    private bufferOffset = 0;
    private readonly bufferSize: number;
    private readonly maxBatchSize: number;
    private readonly maxDelayMs: number;
    private readonly syncMode: SyncMode;
    private batchTimer: NodeJS.Timeout | null = null;
    private processing = false;

    // Metrics
    private totalEvents = 0;
    private totalBytes = 0;
    private fsyncCount = 0;
    private latencies: number[] = [];
    private startTime = Date.now();

    constructor(config: {
        dataDir?: string;
        bufferSizeKB?: number;
        maxBatchSize?: number;
        maxDelayMs?: number;
        syncMode?: SyncMode;
    } = {}) {
        this.dataDir = config.dataDir || './data/wal';
        this.bufferSize = (config.bufferSizeKB || 4096) * 1024; // 4MB default
        this.writeBuffer = Buffer.allocUnsafe(this.bufferSize);
        this.maxBatchSize = config.maxBatchSize || 5000;
        this.maxDelayMs = config.maxDelayMs || 2;
        this.syncMode = config.syncMode || 'batched';
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;

        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }

        // Find existing segments
        const files = fs.readdirSync(this.dataDir)
            .filter(f => f.startsWith('wal_') && f.endsWith('.seg'))
            .sort();

        if (files.length > 0) {
            // Recover from last segment
            const lastFile = files[files.length - 1]!;
            this.filePath = path.join(this.dataDir, lastFile);
            this.segmentId = parseInt(lastFile.slice(4, 14), 10);
            this.fd = fs.openSync(this.filePath, 'r+');

            // Scan to find last sequence
            await this.recoverSequence();
        } else {
            this.createNewSegment();
        }

        // Start batch timer for batched/periodic modes
        if (this.syncMode !== 'immediate') {
            this.batchTimer = setInterval(() => {
                if (this.pending.length > 0 && !this.processing) {
                    this.flushBatch().catch(console.error);
                }
            }, this.maxDelayMs);
        }

        this.initialized = true;
        this.startTime = Date.now();
    }

    private createNewSegment(): void {
        this.segmentId++;
        const fileName = `wal_${String(this.segmentId).padStart(10, '0')}.seg`;
        this.filePath = path.join(this.dataDir, fileName);
        this.fd = fs.openSync(this.filePath, 'w+');
        this.offset = SEGMENT_HEADER_SIZE;

        // Write segment header
        let off = 0;
        segmentHeaderBuf.writeUInt32LE(MAGIC, off); off += 4;
        segmentHeaderBuf.writeUInt32LE(2, off); off += 4; // version
        segmentHeaderBuf.writeBigUInt64LE(BigInt(this.segmentId), off); off += 8;
        segmentHeaderBuf.writeBigUInt64LE(this.sequence, off); off += 8;
        segmentHeaderBuf.writeBigUInt64LE(0n, off); off += 8; // endSequence
        segmentHeaderBuf.writeBigUInt64LE(0n, off); off += 8; // eventCount
        segmentHeaderBuf.writeBigUInt64LE(BigInt(Date.now()), off); off += 8;
        segmentHeaderBuf.writeBigUInt64LE(0n, off); // sealedAt

        fs.writeSync(this.fd, segmentHeaderBuf, 0, SEGMENT_HEADER_SIZE, 0);
    }

    private async recoverSequence(): Promise<void> {
        if (!this.fd) return;

        const stats = fs.fstatSync(this.fd);
        let readOffset = SEGMENT_HEADER_SIZE;
        const eventHeader = Buffer.alloc(EVENT_HEADER_SIZE);

        while (readOffset < stats.size) {
            const bytesRead = fs.readSync(this.fd, eventHeader, 0, EVENT_HEADER_SIZE, readOffset);
            if (bytesRead < EVENT_HEADER_SIZE) break;

            const seq = eventHeader.readBigUInt64LE(0);
            const totalLen = eventHeader.readUInt32LE(20);

            if (seq >= this.sequence) {
                this.sequence = seq + 1n;
            }

            readOffset += EVENT_HEADER_SIZE + totalLen;
        }

        this.offset = readOffset;
    }

    /**
     * Append event - optimized for throughput
     */
    append(input: WALEventInput): Promise<WALAppendResult> {
        return new Promise((resolve, reject) => {
            if (!this.initialized) {
                reject(new Error('WAL not initialized'));
                return;
            }

            const payloadBuf = Buffer.from(JSON.stringify(input.payload));

            this.pending.push({
                tenantId: input.tenantId,
                eventType: input.eventType,
                payload: payloadBuf,
                resolve,
                reject,
                enqueuedAt: performance.now()
            });

            // Immediate mode or batch full
            if (this.syncMode === 'immediate') {
                this.flushBatch().catch(reject);
            } else if (this.pending.length >= this.maxBatchSize) {
                this.flushBatch().catch(console.error);
            }
        });
    }

    /**
     * Flush pending events as a batch
     */
    private async flushBatch(): Promise<void> {
        if (this.processing || this.pending.length === 0) return;
        this.processing = true;

        try {
            const batch = this.pending.splice(0, this.maxBatchSize);
            const results: { event: PendingEvent; sequence: bigint }[] = [];

            this.bufferOffset = 0;

            // Encode all events into buffer
            for (const event of batch) {
                const seq = this.sequence++;
                const timestamp = Date.now() * 1000;

                const tenantBuf = Buffer.from(event.tenantId);
                const typeBuf = Buffer.from(event.eventType);
                const totalPayload = tenantBuf.length + typeBuf.length + event.payload.length;
                const eventSize = EVENT_HEADER_SIZE + totalPayload;

                // Check buffer space
                if (this.bufferOffset + eventSize > this.bufferSize) {
                    // Flush current buffer first
                    this.writeBufferToDisk();
                }

                // Write header to buffer
                let off = this.bufferOffset;
                this.writeBuffer.writeBigUInt64LE(seq, off); off += 8;
                this.writeBuffer.writeBigUInt64LE(BigInt(timestamp), off); off += 8;
                this.writeBuffer.writeUInt8(tenantBuf.length, off); off += 1;
                this.writeBuffer.writeUInt8(typeBuf.length, off); off += 1;
                this.writeBuffer.writeUInt16LE(event.payload.length, off); off += 2;
                this.writeBuffer.writeUInt32LE(totalPayload, off); off += 4;

                // Calculate checksum
                const checksumData = Buffer.concat([
                    this.writeBuffer.subarray(this.bufferOffset, off),
                    tenantBuf,
                    typeBuf,
                    event.payload
                ]);
                const checksum = crc32(checksumData);
                this.writeBuffer.writeUInt32LE(checksum, off); off += 4;

                // Write payload parts
                tenantBuf.copy(this.writeBuffer, off); off += tenantBuf.length;
                typeBuf.copy(this.writeBuffer, off); off += typeBuf.length;
                event.payload.copy(this.writeBuffer, off); off += event.payload.length;

                this.bufferOffset = off;
                results.push({ event, sequence: seq });
            }

            // Final flush
            if (this.bufferOffset > 0) {
                this.writeBufferToDisk();
            }

            // Fsync
            fs.fsyncSync(this.fd!);
            this.fsyncCount++;

            // Resolve all
            const now = performance.now();
            for (const { event, sequence } of results) {
                const latencyMicros = Math.round((now - event.enqueuedAt) * 1000);
                this.latencies.push(latencyMicros);
                if (this.latencies.length > 10000) this.latencies.shift();

                this.totalEvents++;
                event.resolve({ sequence, latencyMicros });
            }
        } finally {
            this.processing = false;
        }
    }

    private writeBufferToDisk(): void {
        if (!this.fd || this.bufferOffset === 0) return;

        fs.writeSync(this.fd, this.writeBuffer, 0, this.bufferOffset, this.offset);
        this.totalBytes += this.bufferOffset;
        this.offset += this.bufferOffset;
        this.bufferOffset = 0;
    }

    /**
     * Read events - optimized with buffered reads
     */
    *readEvents(fromSequence = 1n): Generator<{
        sequence: bigint;
        timestamp: number;
        tenantId: string;
        eventType: string;
        payload: Buffer;
        checksum: number;
    }> {
        const files = fs.readdirSync(this.dataDir)
            .filter(f => f.startsWith('wal_') && f.endsWith('.seg'))
            .sort()
            .map(f => path.join(this.dataDir, f));

        const READ_BUFFER_SIZE = 4 * 1024 * 1024; // 4MB read buffer
        const readBuffer = Buffer.allocUnsafe(READ_BUFFER_SIZE);

        for (const filePath of files) {
            const fd = fs.openSync(filePath, 'r');
            const stats = fs.fstatSync(fd);
            let fileOffset = SEGMENT_HEADER_SIZE;

            while (fileOffset < stats.size) {
                // Read large chunk
                const bytesToRead = Math.min(READ_BUFFER_SIZE, stats.size - fileOffset);
                const bytesRead = fs.readSync(fd, readBuffer, 0, bytesToRead, fileOffset);
                if (bytesRead === 0) break;

                let bufferOffset = 0;

                // Process events in buffer
                while (bufferOffset + EVENT_HEADER_SIZE <= bytesRead) {
                    const sequence = readBuffer.readBigUInt64LE(bufferOffset);
                    const timestamp = Number(readBuffer.readBigUInt64LE(bufferOffset + 8));
                    const tenantLen = readBuffer.readUInt8(bufferOffset + 16);
                    const typeLen = readBuffer.readUInt8(bufferOffset + 17);
                    const payloadLen = readBuffer.readUInt16LE(bufferOffset + 18);
                    const totalLen = readBuffer.readUInt32LE(bufferOffset + 20);
                    const checksum = readBuffer.readUInt32LE(bufferOffset + 24);

                    const eventSize = EVENT_HEADER_SIZE + totalLen;

                    // Check if full event is in buffer
                    if (bufferOffset + eventSize > bytesRead) {
                        // Partial event - need to read more
                        break;
                    }

                    if (sequence >= fromSequence) {
                        const dataStart = bufferOffset + EVENT_HEADER_SIZE;
                        const tenantId = readBuffer.subarray(dataStart, dataStart + tenantLen).toString();
                        const eventType = readBuffer.subarray(dataStart + tenantLen, dataStart + tenantLen + typeLen).toString();
                        const payload = Buffer.from(readBuffer.subarray(dataStart + tenantLen + typeLen, dataStart + totalLen));

                        yield { sequence, timestamp, tenantId, eventType, payload, checksum };
                    }

                    bufferOffset += eventSize;
                }

                fileOffset += bufferOffset;
            }

            fs.closeSync(fd);
        }
    }

    getHeadSequence(): bigint {
        return this.sequence - 1n;
    }

    getMetrics(): {
        totalEvents: number;
        totalBytes: number;
        eventsPerSecond: number;
        fsyncCount: number;
        pendingWrites: number;
        latencyP50: number;
        latencyP95: number;
        latencyP99: number;
        avgLatency: number;
    } {
        const elapsed = Math.max(1, (Date.now() - this.startTime) / 1000);
        const sorted = [...this.latencies].sort((a, b) => a - b);

        return {
            totalEvents: this.totalEvents,
            totalBytes: this.totalBytes,
            eventsPerSecond: this.totalEvents / elapsed,
            fsyncCount: this.fsyncCount,
            pendingWrites: this.pending.length,
            latencyP50: sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.5)]! : 0,
            latencyP95: sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)]! : 0,
            latencyP99: sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.99)]! : 0,
            avgLatency: sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0
        };
    }

    async shutdown(): Promise<void> {
        if (this.batchTimer) {
            clearInterval(this.batchTimer);
            this.batchTimer = null;
        }

        // Flush remaining
        while (this.pending.length > 0) {
            await this.flushBatch();
        }

        if (this.fd) {
            fs.fsyncSync(this.fd);
            fs.closeSync(this.fd);
            this.fd = null;
        }

        this.initialized = false;
    }
}
