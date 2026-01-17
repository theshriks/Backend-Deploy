/**
 * WAL Engine - Core Write-Ahead Log Implementation
 * Single-writer discipline with batch support and backpressure
 */

import * as path from 'path';
import {
    WALEvent,
    WALSegment,
    WALConfig,
    WALAppendResult,
    WALReadOptions,
    WALMetrics,
    IWALEngine
} from '../contracts/types';
import {
    createSegment,
    writeEvent,
    syncSegment,
    sealSegment,
    closeSegment,
    getSegmentSize,
    openSegmentForReading,
    readNextEvent,
    closeSegmentReader,
    listSegmentFiles,
    SegmentWriter
} from './segment';
import { crc32String } from './crc32';

const DEFAULT_CONFIG: WALConfig = {
    dataDir: './data/wal',
    maxSegmentSizeBytes: 64 * 1024 * 1024, // 64MB
    syncMode: 'batch',
    batchSize: 100,
    syncIntervalMs: 100,
    enableChecksums: true,
    compression: 'none'
};

interface BatchedEvent {
    tenantId: string;
    eventType: string;
    payload: Record<string, unknown>;
    resolve: (result: WALAppendResult) => void;
    reject: (error: Error) => void;
    enqueuedAt: number;
}

interface LatencyTracker {
    samples: number[];
    maxSamples: number;
    windowStart: number;
    windowEvents: number;
}

export class WALEngine implements IWALEngine {
    private config: WALConfig;
    private currentSegment: SegmentWriter | null = null;
    private sealedSegments: WALSegment[] = [];
    private nextSequence: bigint = 1n;
    private initialized: boolean = false;

    // Batching
    private batchQueue: BatchedEvent[] = [];
    private batchTimer: NodeJS.Timeout | null = null;
    private processing: boolean = false;

    // Backpressure
    private backpressureActive: boolean = false;
    private readonly maxQueueDepth = 10000;
    private readonly maxMemoryBytes = 100 * 1024 * 1024; // 100MB

    // Metrics
    private totalEventsWritten: bigint = 0n;
    private totalBytesWritten: bigint = 0n;
    private latencyTracker: LatencyTracker = {
        samples: [],
        maxSamples: 10000,
        windowStart: Date.now(),
        windowEvents: 0
    };

    constructor(config: Partial<WALConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;

        // Load existing segments
        const segmentFiles = listSegmentFiles(this.config.dataDir);

        for (const filePath of segmentFiles) {
            try {
                const reader = openSegmentForReading(filePath);
                const segment = reader.segment;
                closeSegmentReader(reader);

                if (segment.sealed) {
                    this.sealedSegments.push(segment);
                    if (segment.endSequence !== null && segment.endSequence >= this.nextSequence) {
                        this.nextSequence = segment.endSequence + 1n;
                    }
                } else {
                    // Recover from unsealed segment
                    const recoveredEvents = await this.recoverFromSegment(filePath);
                    if (recoveredEvents > 0) {
                        console.log(`Recovered ${recoveredEvents} events from unsealed segment`);
                    }
                }
            } catch (error) {
                console.error(`Error loading segment ${filePath}:`, error);
            }
        }

        // Create new active segment
        const newSegmentId = this.sealedSegments.length > 0
            ? Math.max(...this.sealedSegments.map(s => s.segmentId)) + 1
            : 0;

        this.currentSegment = createSegment(this.config.dataDir, newSegmentId, this.nextSequence);

        // Start batch timer if using batch sync
        if (this.config.syncMode === 'batch' || this.config.syncMode === 'periodic') {
            this.startBatchTimer();
        }

        this.initialized = true;
    }

    private async recoverFromSegment(filePath: string): Promise<number> {
        const reader = openSegmentForReading(filePath);
        let eventCount = 0;
        let maxSequence = this.nextSequence - 1n;

        try {
            while (true) {
                const event = readNextEvent(reader);
                if (!event) break;
                eventCount++;
                if (event.sequence > maxSequence) {
                    maxSequence = event.sequence;
                }
            }
        } catch (error) {
            // Partial read - truncated segment
            console.warn(`Segment recovery stopped at event ${eventCount}: ${error}`);
        }

        closeSegmentReader(reader);
        this.nextSequence = maxSequence + 1n;

        // Seal the recovered segment
        const recoverReader = openSegmentForReading(filePath);
        const segment = recoverReader.segment;
        closeSegmentReader(recoverReader);

        // Mark as sealed with what we could recover
        segment.sealed = true;
        segment.endSequence = maxSequence;
        this.sealedSegments.push(segment);

        return eventCount;
    }

    private startBatchTimer(): void {
        if (this.batchTimer) return;

        this.batchTimer = setInterval(() => {
            this.processBatch().catch(err => {
                console.error('Batch processing error:', err);
            });
        }, this.config.syncIntervalMs);
    }

    private stopBatchTimer(): void {
        if (this.batchTimer) {
            clearInterval(this.batchTimer);
            this.batchTimer = null;
        }
    }

    async appendEvent(
        tenantId: string,
        eventType: string,
        payload: Record<string, unknown>
    ): Promise<WALAppendResult> {
        if (!this.initialized) {
            throw new Error('WAL engine not initialized');
        }

        // Check backpressure
        if (this.batchQueue.length >= this.maxQueueDepth) {
            this.backpressureActive = true;
            throw new Error('WAL backpressure: queue full');
        }

        return new Promise((resolve, reject) => {
            const event: BatchedEvent = {
                tenantId,
                eventType,
                payload,
                resolve,
                reject,
                enqueuedAt: performance.now()
            };

            this.batchQueue.push(event);

            // Immediate sync mode
            if (this.config.syncMode === 'immediate') {
                this.processBatch().catch(reject);
            }
            // Check if batch is full
            else if (this.batchQueue.length >= this.config.batchSize) {
                this.processBatch().catch(err => {
                    console.error('Batch processing error:', err);
                });
            }
        });
    }

    async appendEvents(
        events: Array<{ tenantId: string; eventType: string; payload: Record<string, unknown> }>
    ): Promise<WALAppendResult[]> {
        const results: Promise<WALAppendResult>[] = events.map(e =>
            this.appendEvent(e.tenantId, e.eventType, e.payload)
        );
        return Promise.all(results);
    }

    private async processBatch(): Promise<void> {
        if (this.processing || this.batchQueue.length === 0) return;

        this.processing = true;
        const batch = this.batchQueue.splice(0, this.config.batchSize);

        try {
            const results: WALAppendResult[] = [];

            for (const batchedEvent of batch) {
                const startTime = performance.now();

                // Check if segment rotation needed
                if (this.currentSegment && getSegmentSize(this.currentSegment) >= this.config.maxSegmentSizeBytes) {
                    await this.rotateSegment();
                }

                if (!this.currentSegment) {
                    throw new Error('No active segment');
                }

                // Create WAL event
                const event: WALEvent = {
                    sequence: this.nextSequence++,
                    timestamp: new Date().toISOString(),
                    tenantId: batchedEvent.tenantId,
                    eventType: batchedEvent.eventType,
                    payload: batchedEvent.payload,
                    checksum: 0 // Will be computed during write
                };

                // Compute checksum if enabled
                if (this.config.enableChecksums) {
                    const dataStr = `${event.sequence}${event.timestamp}${event.tenantId}${event.eventType}${JSON.stringify(event.payload)}`;
                    event.checksum = crc32String(dataStr);
                }

                // Write event
                const { offset, bytesWritten } = writeEvent(this.currentSegment, event);

                const endTime = performance.now();
                const latencyMicros = Math.round((endTime - startTime) * 1000);

                // Track metrics
                this.totalEventsWritten++;
                this.totalBytesWritten += BigInt(bytesWritten);
                this.recordLatency(latencyMicros);

                const result: WALAppendResult = {
                    sequence: event.sequence,
                    segmentId: this.currentSegment.segmentId,
                    offset,
                    latencyMicros
                };

                results.push(result);
                batchedEvent.resolve(result);
            }

            // Sync after batch
            if (this.currentSegment) {
                syncSegment(this.currentSegment);
            }

            // Update backpressure
            this.backpressureActive = this.batchQueue.length >= this.maxQueueDepth * 0.8;

        } catch (error) {
            // Reject all pending events in batch
            for (const batchedEvent of batch) {
                batchedEvent.reject(error instanceof Error ? error : new Error(String(error)));
            }
        } finally {
            this.processing = false;
        }
    }

    private recordLatency(latencyMicros: number): void {
        this.latencyTracker.samples.push(latencyMicros);
        this.latencyTracker.windowEvents++;

        // Keep samples bounded
        if (this.latencyTracker.samples.length > this.latencyTracker.maxSamples) {
            this.latencyTracker.samples.shift();
        }

        // Reset window every minute
        const now = Date.now();
        if (now - this.latencyTracker.windowStart > 60000) {
            this.latencyTracker.windowStart = now;
            this.latencyTracker.windowEvents = 0;
        }
    }

    async *readEvents(options: WALReadOptions): AsyncGenerator<WALEvent, void, unknown> {
        if (!this.initialized) {
            throw new Error('WAL engine not initialized');
        }

        const fromSequence = options.fromSequence ?? 1n;
        const toSequence = options.toSequence ?? this.nextSequence - 1n;
        let count = 0;
        const limit = options.limit ?? Number.MAX_SAFE_INTEGER;

        // Read from sealed segments
        for (const segment of this.sealedSegments) {
            if (segment.endSequence !== null && segment.endSequence < fromSequence) continue;
            if (segment.startSequence > toSequence) break;

            const reader = openSegmentForReading(segment.filePath);

            try {
                while (count < limit) {
                    const event = readNextEvent(reader);
                    if (!event) break;

                    if (event.sequence < fromSequence) continue;
                    if (event.sequence > toSequence) break;

                    // Apply filters
                    if (options.tenantId && event.tenantId !== options.tenantId) continue;
                    if (options.eventTypes && !options.eventTypes.includes(event.eventType)) continue;

                    yield event;
                    count++;
                }
            } finally {
                closeSegmentReader(reader);
            }
        }

        // Read from current segment if needed
        if (this.currentSegment && count < limit) {
            // Sync current segment to ensure all data is readable
            syncSegment(this.currentSegment);

            const reader = openSegmentForReading(this.currentSegment.filePath);

            try {
                while (count < limit) {
                    const event = readNextEvent(reader);
                    if (!event) break;

                    if (event.sequence < fromSequence) continue;
                    if (event.sequence > toSequence) break;

                    // Apply filters
                    if (options.tenantId && event.tenantId !== options.tenantId) continue;
                    if (options.eventTypes && !options.eventTypes.includes(event.eventType)) continue;

                    yield event;
                    count++;
                }
            } finally {
                closeSegmentReader(reader);
            }
        }
    }

    getHeadSequence(): bigint {
        return this.nextSequence - 1n;
    }

    getMetrics(): WALMetrics {
        const samples = [...this.latencyTracker.samples].sort((a, b) => a - b);
        const p50 = samples.length > 0 ? samples[Math.floor(samples.length * 0.5)] : 0;
        const p95 = samples.length > 0 ? samples[Math.floor(samples.length * 0.95)] : 0;
        const p99 = samples.length > 0 ? samples[Math.floor(samples.length * 0.99)] : 0;

        const windowDurationSeconds = (Date.now() - this.latencyTracker.windowStart) / 1000;
        const eventsPerSecond = windowDurationSeconds > 0
            ? this.latencyTracker.windowEvents / windowDurationSeconds
            : 0;

        return {
            totalEvents: this.totalEventsWritten,
            totalBytesWritten: this.totalBytesWritten,
            currentSegmentId: this.currentSegment?.segmentId ?? -1,
            sealedSegments: this.sealedSegments.length,
            writeLatencyP50: p50,
            writeLatencyP95: p95,
            writeLatencyP99: p99,
            eventsPerSecond,
            bytesPerSecond: eventsPerSecond * 200, // Rough estimate
            batchQueueDepth: this.batchQueue.length,
            backpressureActive: this.backpressureActive
        };
    }

    async rotateSegment(): Promise<void> {
        if (!this.currentSegment) return;

        // Seal current segment
        const sealed = sealSegment(this.currentSegment);
        this.sealedSegments.push(sealed);

        // Create new segment
        this.currentSegment = createSegment(
            this.config.dataDir,
            sealed.segmentId + 1,
            this.nextSequence
        );
    }

    async shutdown(): Promise<void> {
        this.stopBatchTimer();

        // Process remaining batch
        while (this.batchQueue.length > 0) {
            await this.processBatch();
        }

        // Close current segment
        if (this.currentSegment) {
            closeSegment(this.currentSegment);
            this.currentSegment = null;
        }

        this.initialized = false;
    }

    /**
     * Get all segments (for snapshot engine)
     */
    getAllSegments(): WALSegment[] {
        const segments = [...this.sealedSegments];

        if (this.currentSegment) {
            segments.push({
                segmentId: this.currentSegment.segmentId,
                startSequence: this.currentSegment.startSequence,
                endSequence: null,
                filePath: this.currentSegment.filePath,
                sizeBytes: getSegmentSize(this.currentSegment),
                sealed: false,
                segmentChecksum: null,
                createdAt: this.currentSegment.createdAt.toISOString(),
                sealedAt: null
            });
        }

        return segments;
    }

    /**
     * Get config
     */
    getConfig(): WALConfig {
        return { ...this.config };
    }
}
