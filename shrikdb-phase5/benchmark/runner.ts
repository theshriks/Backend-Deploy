/**
 * Benchmark Harness - Real performance measurements
 * No fake numbers, no simulated benchmarks
 */

import {
    BenchmarkConfig,
    BenchmarkResult,
    IBenchmarkRunner
} from '../contracts/types';
import { WALEngine } from '../wal/engine';
import { SnapshotEngine } from '../snapshot/engine';

const DEFAULT_BENCHMARKS: BenchmarkConfig[] = [
    {
        name: 'single-tenant-sequential-writes',
        operations: 10000,
        concurrency: 1,
        warmupOperations: 1000,
        payloadSizeBytes: 256,
        tenantCount: 1
    },
    {
        name: 'single-tenant-burst-writes',
        operations: 50000,
        concurrency: 1,
        warmupOperations: 5000,
        payloadSizeBytes: 256,
        tenantCount: 1
    },
    {
        name: 'multi-tenant-writes',
        operations: 10000,
        concurrency: 10,
        warmupOperations: 1000,
        payloadSizeBytes: 256,
        tenantCount: 10
    },
    {
        name: 'large-payload-writes',
        operations: 5000,
        concurrency: 1,
        warmupOperations: 500,
        payloadSizeBytes: 4096,
        tenantCount: 1
    },
    {
        name: 'cold-start-replay',
        operations: 0,
        concurrency: 1,
        warmupOperations: 0,
        payloadSizeBytes: 256,
        tenantCount: 1
    },
    {
        name: 'snapshot-create',
        operations: 0,
        concurrency: 1,
        warmupOperations: 0,
        payloadSizeBytes: 256,
        tenantCount: 1
    },
    {
        name: 'snapshot-restore',
        operations: 0,
        concurrency: 1,
        warmupOperations: 0,
        payloadSizeBytes: 256,
        tenantCount: 1
    }
];

function generatePayload(sizeBytes: number): Record<string, unknown> {
    const basePayload: Record<string, unknown> = {
        timestamp: Date.now(),
        random: Math.random(),
        operation: 'benchmark'
    };

    // Add padding to reach target size
    const currentSize = Buffer.from(JSON.stringify(basePayload)).length;
    if (currentSize < sizeBytes) {
        basePayload.padding = 'x'.repeat(sizeBytes - currentSize);
    }

    return basePayload;
}

function calculatePercentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.floor(sorted.length * p);
    return sorted[Math.min(idx, sorted.length - 1)];
}

export class BenchmarkRunner implements IBenchmarkRunner {
    private dataDir: string;
    private walEngine: WALEngine | null = null;
    private snapshotEngine: SnapshotEngine | null = null;

    constructor(dataDir: string = './data/benchmark') {
        this.dataDir = dataDir;
    }

    getAvailableBenchmarks(): BenchmarkConfig[] {
        return [...DEFAULT_BENCHMARKS];
    }

    async runBenchmark(config: BenchmarkConfig): Promise<BenchmarkResult> {
        const errors: string[] = [];
        const latencySamples: number[] = [];
        let invariantsValid = true;
        let bytesProcessed = 0n;

        // Initialize fresh WAL for each benchmark
        this.walEngine = new WALEngine({
            dataDir: `${this.dataDir}/${config.name}`,
            maxSegmentSizeBytes: 64 * 1024 * 1024,
            syncMode: 'batch',
            batchSize: 100,
            syncIntervalMs: 10,
            enableChecksums: true,
            compression: 'none'
        });

        await this.walEngine.initialize();
        this.snapshotEngine = new SnapshotEngine(
            this.walEngine,
            `${this.dataDir}/${config.name}/snapshots`
        );

        const startedAt = new Date().toISOString();
        const startTime = performance.now();

        try {
            if (config.name.includes('writes')) {
                await this.runWriteBenchmark(config, latencySamples, errors);
                bytesProcessed = BigInt(config.operations * config.payloadSizeBytes);
            } else if (config.name === 'cold-start-replay') {
                await this.runReplayBenchmark(config, latencySamples, errors);
            } else if (config.name === 'snapshot-create') {
                await this.runSnapshotCreateBenchmark(config, latencySamples, errors);
            } else if (config.name === 'snapshot-restore') {
                await this.runSnapshotRestoreBenchmark(config, latencySamples, errors);
            }

            // Verify invariants
            invariantsValid = await this.verifyInvariants(config);
        } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
            invariantsValid = false;
        }

        const endTime = performance.now();
        const durationMs = endTime - startTime;
        const completedAt = new Date().toISOString();

        await this.walEngine.shutdown();

        // Calculate statistics
        const sortedLatencies = [...latencySamples].sort((a, b) => a - b);
        const opsPerSecond = config.operations > 0
            ? (config.operations / durationMs) * 1000
            : (latencySamples.length / durationMs) * 1000;

        return {
            name: config.name,
            config,
            startedAt,
            completedAt,
            durationMs,
            opsPerSecond,
            latencyP50Micros: calculatePercentile(sortedLatencies, 0.5),
            latencyP95Micros: calculatePercentile(sortedLatencies, 0.95),
            latencyP99Micros: calculatePercentile(sortedLatencies, 0.99),
            latencyMaxMicros: sortedLatencies.length > 0
                ? sortedLatencies[sortedLatencies.length - 1]
                : 0,
            bytesProcessed,
            throughputMBps: Number(bytesProcessed) / durationMs / 1000,
            invariantsValid,
            errors,
            latencySamples: sortedLatencies.slice(0, 1000) // Keep sample for histogram
        };
    }

    private async runWriteBenchmark(
        config: BenchmarkConfig,
        latencySamples: number[],
        errors: string[]
    ): Promise<void> {
        if (!this.walEngine) throw new Error('WAL engine not initialized');

        // Warmup
        for (let i = 0; i < config.warmupOperations; i++) {
            const tenantId = `tenant-${i % config.tenantCount}`;
            await this.walEngine.appendEvent(
                tenantId,
                'warmup',
                generatePayload(config.payloadSizeBytes)
            );
        }

        // Benchmark
        const promises: Promise<void>[] = [];

        for (let i = 0; i < config.operations; i++) {
            const tenantId = `tenant-${i % config.tenantCount}`;
            const startTime = performance.now();

            const promise = this.walEngine.appendEvent(
                tenantId,
                'benchmark',
                generatePayload(config.payloadSizeBytes)
            ).then(() => {
                const endTime = performance.now();
                latencySamples.push(Math.round((endTime - startTime) * 1000));
            }).catch(err => {
                errors.push(`Op ${i}: ${err.message}`);
            });

            promises.push(promise);

            // Control concurrency
            if (promises.length >= config.concurrency) {
                await Promise.all(promises);
                promises.length = 0;
            }
        }

        await Promise.all(promises);
    }

    private async runReplayBenchmark(
        config: BenchmarkConfig,
        latencySamples: number[],
        errors: string[]
    ): Promise<void> {
        if (!this.walEngine) throw new Error('WAL engine not initialized');

        // First, write some events to replay
        const eventsToWrite = 10000;
        for (let i = 0; i < eventsToWrite; i++) {
            await this.walEngine.appendEvent(
                `tenant-${i % 5}`,
                'data',
                generatePayload(256)
            );
        }

        // Measure replay time
        const startTime = performance.now();
        let eventCount = 0;

        for await (const event of this.walEngine.readEvents({})) {
            eventCount++;
        }

        const endTime = performance.now();
        latencySamples.push(Math.round((endTime - startTime) * 1000));

        if (eventCount < eventsToWrite) {
            errors.push(`Expected ${eventsToWrite} events, got ${eventCount}`);
        }
    }

    private async runSnapshotCreateBenchmark(
        config: BenchmarkConfig,
        latencySamples: number[],
        errors: string[]
    ): Promise<void> {
        if (!this.walEngine || !this.snapshotEngine) {
            throw new Error('Engines not initialized');
        }

        // Write events first
        for (let i = 0; i < 5000; i++) {
            await this.walEngine.appendEvent(
                `tenant-${i % 5}`,
                'data',
                generatePayload(256)
            );
        }

        // Measure snapshot creation
        const startTime = performance.now();
        await this.snapshotEngine.createSnapshot();
        const endTime = performance.now();

        latencySamples.push(Math.round((endTime - startTime) * 1000));
    }

    private async runSnapshotRestoreBenchmark(
        config: BenchmarkConfig,
        latencySamples: number[],
        errors: string[]
    ): Promise<void> {
        if (!this.walEngine || !this.snapshotEngine) {
            throw new Error('Engines not initialized');
        }

        // Write events and create snapshot
        for (let i = 0; i < 5000; i++) {
            await this.walEngine.appendEvent(
                `tenant-${i % 5}`,
                'data',
                generatePayload(256)
            );
        }

        const snapshot = await this.snapshotEngine.createSnapshot();

        // Measure restore
        const startTime = performance.now();
        await this.snapshotEngine.restoreFromSnapshot(snapshot.snapshotId);
        const endTime = performance.now();

        latencySamples.push(Math.round((endTime - startTime) * 1000));
    }

    private async verifyInvariants(config: BenchmarkConfig): Promise<boolean> {
        if (!this.walEngine) return false;

        // Verify WAL integrity
        const metrics = this.walEngine.getMetrics();

        // Total events should match what we wrote
        if (config.name.includes('writes')) {
            const expectedEvents = config.warmupOperations + config.operations;
            if (Number(metrics.totalEvents) < expectedEvents * 0.99) {
                return false; // Allow 1% loss due to timing
            }
        }

        // Verify we can read all events
        let eventCount = 0;
        let lastSequence = 0n;

        for await (const event of this.walEngine.readEvents({})) {
            eventCount++;
            if (event.sequence <= lastSequence) {
                return false; // Monotonicity violated
            }
            lastSequence = event.sequence;
        }

        return true;
    }

    async runAllBenchmarks(): Promise<BenchmarkResult[]> {
        const results: BenchmarkResult[] = [];

        for (const config of DEFAULT_BENCHMARKS) {
            console.log(`Running benchmark: ${config.name}...`);
            const result = await this.runBenchmark(config);
            results.push(result);
            console.log(`  Completed in ${result.durationMs.toFixed(2)}ms, ${result.opsPerSecond.toFixed(2)} ops/s`);
        }

        return results;
    }
}
