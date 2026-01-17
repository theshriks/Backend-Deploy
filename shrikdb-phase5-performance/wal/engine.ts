/**
 * High-Performance WAL Engine
 * Multiple sync modes, batched writes, optimized throughput
 */

import { WALConfig, WALEvent, WALEventInput, WALAppendResult, SyncMode } from '../contracts/types';
import { WALSegment, listSegments, SegmentInfo } from './segment';
import { WriteBuffer, EventRingBuffer } from './buffer';
import { crc32 } from './crc32';

const DEFAULT_CONFIG: WALConfig = {
    dataDir: './data/wal',
    syncMode: {
        mode: 'batched',
        batchSize: 1000,
        maxDelayMs: 10,
        syncIntervalMs: 100
    },
    segmentSizeBytes: 64 * 1024 * 1024,
    writeBufferSizeBytes: 16 * 1024 * 1024,
    enableChecksums: true
};

interface PendingWrite {
    input: WALEventInput;
    resolve: (result: WALAppendResult) => void;
    reject: (error: Error) => void;
    enqueuedAt: number;
}

interface LatencyTracker {
    samples: number[];
    maxSamples: number;
    totalWrites: number;
    fsyncCount: number;
    startTime: number;
}

export class HighPerformanceWAL {
    private config: WALConfig;
    private currentSegment: WALSegment | null = null;
    private sealedSegments: SegmentInfo[] = [];
    private nextSequence = 1n;
    private initialized = false;

    // Batching
    private pendingWrites: EventRingBuffer<PendingWrite>;
    private writeBuffer: WriteBuffer;
    private batchTimer: NodeJS.Timeout | null = null;
    private periodicTimer: NodeJS.Timeout | null = null;
    private processing = false;

    // Metrics
    private latencyTracker: LatencyTracker = {
        samples: [],
        maxSamples: 10000,
        totalWrites: 0,
        fsyncCount: 0,
        startTime: Date.now()
    };
    private totalBytes = 0n;

    constructor(config: Partial<WALConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.pendingWrites = new EventRingBuffer<PendingWrite>(100000);
        this.writeBuffer = new WriteBuffer(this.config.writeBufferSizeBytes);
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;

        // Load existing segments
        const segmentPaths = listSegments(this.config.dataDir);

        for (const segPath of segmentPaths) {
            try {
                const segment = WALSegment.open(segPath);
                const lastSeq = segment.getLastSequence();

                if (lastSeq >= this.nextSequence) {
                    this.nextSequence = lastSeq + 1n;
                }

                // Seal and track
                const info = segment.seal();
                this.sealedSegments.push(info);
            } catch (error) {
                console.warn(`Error loading segment ${segPath}:`, error);
            }
        }

        // Create new segment
        const newId = this.sealedSegments.length > 0
            ? Math.max(...this.sealedSegments.map(s => s.id)) + 1
            : 0;

        this.currentSegment = WALSegment.create(
            this.config.dataDir,
            newId,
            this.nextSequence
        );

        // Start timers based on sync mode
        this.startTimers();
        this.initialized = true;
    }

    private startTimers(): void {
        const { mode, maxDelayMs, syncIntervalMs } = this.config.syncMode;

        if (mode === 'batched') {
            this.batchTimer = setInterval(() => {
                this.flushBatch().catch(console.error);
            }, maxDelayMs);
        } else if (mode === 'periodic') {
            this.periodicTimer = setInterval(() => {
                this.flushPeriodic().catch(console.error);
            }, syncIntervalMs);
        }
    }

    private stopTimers(): void {
        if (this.batchTimer) {
            clearInterval(this.batchTimer);
            this.batchTimer = null;
        }
        if (this.periodicTimer) {
            clearInterval(this.periodicTimer);
            this.periodicTimer = null;
        }
    }

    /**
     * Append single event
     */
    async append(input: WALEventInput): Promise<WALAppendResult> {
        if (!this.initialized) {
            throw new Error('WAL not initialized');
        }

        return new Promise((resolve, reject) => {
            const pending: PendingWrite = {
                input,
                resolve,
                reject,
                enqueuedAt: performance.now()
            };

            if (!this.pendingWrites.push(pending)) {
                reject(new Error('Write queue full - backpressure'));
                return;
            }

            // Immediate mode: process right away
            if (this.config.syncMode.mode === 'immediate') {
                this.flushImmediate().catch(reject);
            }
            // Batched mode: check if batch is full
            else if (this.config.syncMode.mode === 'batched') {
                if (this.pendingWrites.size >= this.config.syncMode.batchSize) {
                    this.flushBatch().catch(console.error);
                }
            }
            // Periodic: timer will handle it
        });
    }

    /**
     * Append batch of events (faster than individual appends)
     */
    async appendBatch(inputs: WALEventInput[]): Promise<WALAppendResult[]> {
        return Promise.all(inputs.map(input => this.append(input)));
    }

    /**
     * Flush in immediate mode (fsync after every write)
     */
    private async flushImmediate(): Promise<void> {
        if (this.processing) return;
        this.processing = true;

        try {
            while (!this.pendingWrites.isEmpty) {
                const pending = this.pendingWrites.pop();
                if (!pending) break;

                const result = this.writeEventInternal(pending);

                // Sync immediately
                this.currentSegment!.sync();
                this.latencyTracker.fsyncCount++;

                pending.resolve(result);
            }
        } finally {
            this.processing = false;
        }
    }

    /**
     * Flush in batched mode (group commit)
     */
    private async flushBatch(): Promise<void> {
        if (this.processing || this.pendingWrites.isEmpty) return;
        this.processing = true;

        try {
            const batch = this.pendingWrites.drain(this.config.syncMode.batchSize);
            if (batch.length === 0) return;

            const results: { pending: PendingWrite; result: WALAppendResult }[] = [];

            // Write all events
            for (const pending of batch) {
                const result = this.writeEventInternal(pending);
                results.push({ pending, result });
            }

            // Single fsync for entire batch
            this.currentSegment!.sync();
            this.latencyTracker.fsyncCount++;

            // Resolve all
            for (const { pending, result } of results) {
                pending.resolve(result);
            }
        } finally {
            this.processing = false;
        }
    }

    /**
     * Flush in periodic mode
     */
    private async flushPeriodic(): Promise<void> {
        if (this.processing || this.pendingWrites.isEmpty) return;
        this.processing = true;

        try {
            // Drain all pending
            const batch = this.pendingWrites.drain(100000);
            if (batch.length === 0) return;

            const results: { pending: PendingWrite; result: WALAppendResult }[] = [];

            for (const pending of batch) {
                const result = this.writeEventInternal(pending);
                results.push({ pending, result });
            }

            // Periodic sync
            this.currentSegment!.sync();
            this.latencyTracker.fsyncCount++;

            for (const { pending, result } of results) {
                pending.resolve(result);
            }
        } finally {
            this.processing = false;
        }
    }

    /**
     * Internal write - no sync
     */
    private writeEventInternal(pending: PendingWrite): WALAppendResult {
        const startTime = performance.now();
        const sequence = this.nextSequence++;
        const timestamp = Date.now() * 1000; // microseconds

        // Serialize payload
        const payloadBuf = Buffer.from(JSON.stringify(pending.input.payload));

        // Check segment rotation
        if (this.currentSegment!.getSize() >= this.config.segmentSizeBytes) {
            this.rotateSegment();
        }

        // Write to segment
        const bytesWritten = this.currentSegment!.writeEvent(
            sequence,
            timestamp,
            pending.input.tenantId,
            pending.input.eventType,
            payloadBuf
        );

        const endTime = performance.now();
        const latencyMicros = Math.round((endTime - pending.enqueuedAt) * 1000);

        // Track metrics
        this.latencyTracker.samples.push(latencyMicros);
        if (this.latencyTracker.samples.length > this.latencyTracker.maxSamples) {
            this.latencyTracker.samples.shift();
        }
        this.latencyTracker.totalWrites++;
        this.totalBytes += BigInt(bytesWritten);

        return { sequence, latencyMicros };
    }

    /**
     * Rotate to new segment
     */
    private rotateSegment(): void {
        if (!this.currentSegment) return;

        const info = this.currentSegment.seal();
        this.sealedSegments.push(info);

        this.currentSegment = WALSegment.create(
            this.config.dataDir,
            info.id + 1,
            this.nextSequence
        );
    }

    /**
     * Read all events
     */
    *readEvents(fromSequence = 1n): Generator<WALEvent> {
        // Read from sealed segments
        for (const info of this.sealedSegments) {
            if (info.endSequence !== null && info.endSequence < fromSequence) continue;

            const segment = WALSegment.open(info.path);
            try {
                for (const event of segment.readEvents()) {
                    if (event.sequence < fromSequence) continue;
                    yield {
                        sequence: event.sequence,
                        timestamp: event.timestamp,
                        tenantId: event.tenantId,
                        eventType: event.eventType,
                        payload: event.payload,
                        checksum: event.checksum
                    };
                }
            } finally {
                segment.close();
            }
        }

        // Read from current segment
        if (this.currentSegment) {
            for (const event of this.currentSegment.readEvents()) {
                if (event.sequence < fromSequence) continue;
                yield {
                    sequence: event.sequence,
                    timestamp: event.timestamp,
                    tenantId: event.tenantId,
                    eventType: event.eventType,
                    payload: event.payload,
                    checksum: event.checksum
                };
            }
        }
    }

    /**
     * Get current sequence
     */
    getHeadSequence(): bigint {
        return this.nextSequence - 1n;
    }

    /**
     * Get metrics
     */
    getMetrics(): {
        totalEvents: bigint;
        totalBytes: bigint;
        eventsPerSecond: number;
        fsyncCount: number;
        pendingWrites: number;
        latencyP50: number;
        latencyP95: number;
        latencyP99: number;
        avgLatency: number;
    } {
        const samples = [...this.latencyTracker.samples].sort((a, b) => a - b);
        const elapsed = (Date.now() - this.latencyTracker.startTime) / 1000;

        return {
            totalEvents: BigInt(this.latencyTracker.totalWrites),
            totalBytes: this.totalBytes,
            eventsPerSecond: elapsed > 0 ? this.latencyTracker.totalWrites / elapsed : 0,
            fsyncCount: this.latencyTracker.fsyncCount,
            pendingWrites: this.pendingWrites.size,
            latencyP50: samples.length > 0 ? samples[Math.floor(samples.length * 0.5)]! : 0,
            latencyP95: samples.length > 0 ? samples[Math.floor(samples.length * 0.95)]! : 0,
            latencyP99: samples.length > 0 ? samples[Math.floor(samples.length * 0.99)]! : 0,
            avgLatency: samples.length > 0
                ? samples.reduce((a, b) => a + b, 0) / samples.length
                : 0
        };
    }

    /**
     * Shutdown
     */
    async shutdown(): Promise<void> {
        this.stopTimers();

        // Flush remaining writes
        while (!this.pendingWrites.isEmpty) {
            await this.flushBatch();
        }

        if (this.currentSegment) {
            this.currentSegment.close();
            this.currentSegment = null;
        }

        this.initialized = false;
    }
}
