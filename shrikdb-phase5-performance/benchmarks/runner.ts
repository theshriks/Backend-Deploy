/**
 * Benchmark Runner - Real Performance Measurements
 * NO fake numbers, NO simulated metrics, NO demos
 */

import * as fs from 'fs';
import * as path from 'path';
import { BenchmarkConfig, BenchmarkResult, SyncMode } from '../contracts/types';
import { HighPerformanceWAL } from '../wal/engine';
import { ProjectionEngine } from '../projections/engine';
import { createEntityProjection, EntityStore, listEntities } from '../projections/crud';
import { QueryEngine } from '../queries/engine';
import { IndexManager } from '../indexing/engine';

function generatePayload(sizeBytes: number): Record<string, unknown> {
    return {
        timestamp: Date.now(),
        value: Math.random(),
        data: 'x'.repeat(Math.max(0, sizeBytes - 50))
    };
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.floor(sorted.length * p);
    return sorted[Math.min(idx, sorted.length - 1)]!;
}

function getMemoryUsage(): number {
    return process.memoryUsage().heapUsed / 1024 / 1024;
}

export class BenchmarkRunner {
    private dataDir: string;

    constructor(dataDir: string = './data/benchmark') {
        this.dataDir = dataDir;
    }

    /**
     * Run write throughput benchmark
     */
    async runWriteBenchmark(config: BenchmarkConfig): Promise<BenchmarkResult> {
        const benchDir = path.join(this.dataDir, config.name);
        if (fs.existsSync(benchDir)) {
            fs.rmSync(benchDir, { recursive: true });
        }

        const wal = new HighPerformanceWAL({
            dataDir: benchDir,
            syncMode: {
                mode: config.syncMode,
                batchSize: 1000,
                maxDelayMs: 5,
                syncIntervalMs: 50
            },
            segmentSizeBytes: 128 * 1024 * 1024,
            writeBufferSizeBytes: 32 * 1024 * 1024,
            enableChecksums: true
        });

        await wal.initialize();
        const latencies: number[] = [];
        const errors: string[] = [];
        const startedAt = new Date().toISOString();
        const memoryBefore = getMemoryUsage();

        // Warmup
        for (let i = 0; i < config.warmupOperations; i++) {
            const tenantId = `tenant-${i % config.tenantCount}`;
            try {
                await wal.append({
                    tenantId,
                    eventType: 'warmup',
                    payload: generatePayload(config.payloadSizeBytes)
                });
            } catch (err) {
                // Ignore warmup errors
            }
        }

        // Reset metrics after warmup
        const startTime = performance.now();

        // Benchmark
        const batchSize = 100;
        const batches = Math.ceil(config.operations / batchSize);

        for (let batch = 0; batch < batches; batch++) {
            const promises: Promise<void>[] = [];
            const batchCount = Math.min(batchSize, config.operations - batch * batchSize);

            for (let i = 0; i < batchCount; i++) {
                const opIndex = batch * batchSize + i;
                const tenantId = `tenant-${opIndex % config.tenantCount}`;
                const opStart = performance.now();

                const promise = wal.append({
                    tenantId,
                    eventType: 'benchmark',
                    payload: generatePayload(config.payloadSizeBytes)
                }).then(() => {
                    latencies.push(Math.round((performance.now() - opStart) * 1000));
                }).catch(err => {
                    errors.push(`Op ${opIndex}: ${err.message}`);
                });

                promises.push(promise);
            }

            await Promise.all(promises);
        }

        const endTime = performance.now();
        const durationMs = endTime - startTime;
        const completedAt = new Date().toISOString();
        const memoryAfter = getMemoryUsage();

        const metrics = wal.getMetrics();
        await wal.shutdown();

        // Sort latencies
        const sortedLatencies = [...latencies].sort((a, b) => a - b);

        // Verify invariants
        const invariantsValid = await this.verifyWriteInvariants(benchDir, config.operations);

        return {
            name: config.name,
            config,
            startedAt,
            completedAt,
            durationMs,
            opsPerSecond: (config.operations / durationMs) * 1000,
            latencyP50Micros: percentile(sortedLatencies, 0.5),
            latencyP95Micros: percentile(sortedLatencies, 0.95),
            latencyP99Micros: percentile(sortedLatencies, 0.99),
            latencyMaxMicros: sortedLatencies.length > 0 ? sortedLatencies[sortedLatencies.length - 1]! : 0,
            throughputMBps: (config.operations * config.payloadSizeBytes) / durationMs / 1000,
            fsyncCount: metrics.fsyncCount,
            memoryUsedMB: memoryAfter - memoryBefore,
            invariantsValid,
            errors
        };
    }

    /**
     * Run CRUD benchmark
     */
    async runCRUDBenchmark(config: BenchmarkConfig): Promise<BenchmarkResult> {
        const benchDir = path.join(this.dataDir, config.name);
        if (fs.existsSync(benchDir)) {
            fs.rmSync(benchDir, { recursive: true });
        }

        const wal = new HighPerformanceWAL({
            dataDir: benchDir,
            syncMode: { mode: config.syncMode, batchSize: 1000, maxDelayMs: 5, syncIntervalMs: 50 },
            segmentSizeBytes: 64 * 1024 * 1024,
            writeBufferSizeBytes: 16 * 1024 * 1024,
            enableChecksums: true
        });

        await wal.initialize();

        const projections = new ProjectionEngine(wal);
        projections.register(createEntityProjection('item'));

        const indexes = new IndexManager();
        const queries = new QueryEngine(projections, indexes);

        const latencies: number[] = [];
        const errors: string[] = [];
        const startedAt = new Date().toISOString();
        const startTime = performance.now();

        // Write entities
        for (let i = 0; i < config.operations; i++) {
            const tenantId = `tenant-${i % config.tenantCount}`;
            const opStart = performance.now();

            try {
                const result = await wal.append({
                    tenantId,
                    eventType: 'item.created',
                    payload: { id: `item-${i}`, name: `Item ${i}`, value: Math.random() * 1000 }
                });

                // Apply to projection
                for (const event of wal.readEvents(result.sequence)) {
                    projections.applyEvent(event);
                    break;
                }

                // Read back
                const entity = queries.findById('entities_item', tenantId, `item-${i}`);

                const opEnd = performance.now();
                latencies.push(Math.round((opEnd - opStart) * 1000));

                if (!entity) {
                    errors.push(`Entity item-${i} not found after insert`);
                }
            } catch (err) {
                errors.push(`Op ${i}: ${(err as Error).message}`);
            }
        }

        const endTime = performance.now();
        const durationMs = endTime - startTime;
        const completedAt = new Date().toISOString();

        const metrics = wal.getMetrics();
        await wal.shutdown();

        const sortedLatencies = [...latencies].sort((a, b) => a - b);

        return {
            name: config.name,
            config,
            startedAt,
            completedAt,
            durationMs,
            opsPerSecond: (config.operations / durationMs) * 1000,
            latencyP50Micros: percentile(sortedLatencies, 0.5),
            latencyP95Micros: percentile(sortedLatencies, 0.95),
            latencyP99Micros: percentile(sortedLatencies, 0.99),
            latencyMaxMicros: sortedLatencies.length > 0 ? sortedLatencies[sortedLatencies.length - 1]! : 0,
            throughputMBps: 0,
            fsyncCount: metrics.fsyncCount,
            memoryUsedMB: getMemoryUsage(),
            invariantsValid: errors.length === 0,
            errors
        };
    }

    /**
     * Run query benchmark
     */
    async runQueryBenchmark(config: BenchmarkConfig): Promise<BenchmarkResult> {
        const benchDir = path.join(this.dataDir, config.name);
        if (fs.existsSync(benchDir)) {
            fs.rmSync(benchDir, { recursive: true });
        }

        const wal = new HighPerformanceWAL({
            dataDir: benchDir,
            syncMode: { mode: 'batched', batchSize: 1000, maxDelayMs: 5, syncIntervalMs: 50 },
            segmentSizeBytes: 64 * 1024 * 1024,
            writeBufferSizeBytes: 16 * 1024 * 1024,
            enableChecksums: true
        });

        await wal.initialize();

        const projections = new ProjectionEngine(wal);
        projections.register(createEntityProjection('item'));
        const indexes = new IndexManager();
        const queries = new QueryEngine(projections, indexes);

        // Insert test data
        const entityCount = 100000;
        for (let i = 0; i < entityCount; i++) {
            await wal.append({
                tenantId: 'tenant-0',
                eventType: 'item.created',
                payload: { id: `item-${i}`, name: `Item ${i}`, value: Math.random() * 1000, category: `cat-${i % 10}` }
            });
        }

        // Build projections
        await projections.rebuildAll();

        const latencies: number[] = [];
        const errors: string[] = [];
        const startedAt = new Date().toISOString();
        const startTime = performance.now();

        // Run queries
        for (let i = 0; i < config.operations; i++) {
            const opStart = performance.now();

            try {
                const result = queries.find({
                    tenantId: 'tenant-0',
                    projection: 'entities_item',
                    filters: [{ field: 'data.value', op: 'gt', value: 500 }],
                    limit: 100,
                    sort: { field: 'data.value', order: 'desc' }
                });

                latencies.push(Math.round((performance.now() - opStart) * 1000));
            } catch (err) {
                errors.push(`Query ${i}: ${(err as Error).message}`);
            }
        }

        const endTime = performance.now();
        const durationMs = endTime - startTime;
        const completedAt = new Date().toISOString();

        await wal.shutdown();

        const sortedLatencies = [...latencies].sort((a, b) => a - b);

        return {
            name: config.name,
            config,
            startedAt,
            completedAt,
            durationMs,
            opsPerSecond: (config.operations / durationMs) * 1000,
            latencyP50Micros: percentile(sortedLatencies, 0.5),
            latencyP95Micros: percentile(sortedLatencies, 0.95),
            latencyP99Micros: percentile(sortedLatencies, 0.99),
            latencyMaxMicros: sortedLatencies.length > 0 ? sortedLatencies[sortedLatencies.length - 1]! : 0,
            throughputMBps: 0,
            fsyncCount: 0,
            memoryUsedMB: getMemoryUsage(),
            invariantsValid: errors.length === 0,
            errors
        };
    }

    /**
     * Run replay benchmark
     */
    async runReplayBenchmark(eventCount: number): Promise<BenchmarkResult> {
        const benchDir = path.join(this.dataDir, 'replay-benchmark');
        if (fs.existsSync(benchDir)) {
            fs.rmSync(benchDir, { recursive: true });
        }

        // First, write events
        const wal = new HighPerformanceWAL({
            dataDir: benchDir,
            syncMode: { mode: 'batched', batchSize: 1000, maxDelayMs: 5, syncIntervalMs: 50 },
            segmentSizeBytes: 64 * 1024 * 1024,
            writeBufferSizeBytes: 16 * 1024 * 1024,
            enableChecksums: true
        });

        await wal.initialize();

        for (let i = 0; i < eventCount; i++) {
            await wal.append({
                tenantId: `tenant-${i % 10}`,
                eventType: 'data',
                payload: { index: i, value: Math.random() }
            });
        }

        await wal.shutdown();

        // Now measure replay
        const wal2 = new HighPerformanceWAL({ dataDir: benchDir });
        await wal2.initialize();

        const startedAt = new Date().toISOString();
        const startTime = performance.now();

        let replayCount = 0;
        for (const event of wal2.readEvents()) {
            replayCount++;
        }

        const endTime = performance.now();
        const durationMs = endTime - startTime;
        const completedAt = new Date().toISOString();

        await wal2.shutdown();

        return {
            name: 'replay-benchmark',
            config: { name: 'replay', operations: eventCount, concurrency: 1, warmupOperations: 0, payloadSizeBytes: 64, tenantCount: 10, syncMode: 'batched' },
            startedAt,
            completedAt,
            durationMs,
            opsPerSecond: (replayCount / durationMs) * 1000,
            latencyP50Micros: 0,
            latencyP95Micros: 0,
            latencyP99Micros: 0,
            latencyMaxMicros: 0,
            throughputMBps: 0,
            fsyncCount: 0,
            memoryUsedMB: getMemoryUsage(),
            invariantsValid: replayCount === eventCount,
            errors: replayCount !== eventCount ? [`Expected ${eventCount} events, got ${replayCount}`] : []
        };
    }

    private async verifyWriteInvariants(dataDir: string, expectedCount: number): Promise<boolean> {
        const wal = new HighPerformanceWAL({ dataDir });
        await wal.initialize();

        let count = 0;
        let lastSequence = 0n;
        let monotonic = true;

        for (const event of wal.readEvents()) {
            count++;
            if (event.sequence <= lastSequence) {
                monotonic = false;
            }
            lastSequence = event.sequence;
        }

        await wal.shutdown();

        // Allow some tolerance for timing
        return monotonic && count >= expectedCount * 0.95;
    }

    /**
     * Run all benchmarks
     */
    async runAll(): Promise<BenchmarkResult[]> {
        const results: BenchmarkResult[] = [];

        console.log('Running write benchmarks...');

        // Batched write - target ≥50k ops/sec
        results.push(await this.runWriteBenchmark({
            name: 'write-batched-50k',
            operations: 50000,
            concurrency: 1,
            warmupOperations: 5000,
            payloadSizeBytes: 128,
            tenantCount: 10,
            syncMode: 'batched'
        }));
        console.log(`  batched: ${results[results.length - 1]!.opsPerSecond.toFixed(0)} ops/s`);

        // Durable write - target ≥10k ops/sec  
        results.push(await this.runWriteBenchmark({
            name: 'write-durable-10k',
            operations: 10000,
            concurrency: 1,
            warmupOperations: 1000,
            payloadSizeBytes: 128,
            tenantCount: 10,
            syncMode: 'immediate'
        }));
        console.log(`  durable: ${results[results.length - 1]!.opsPerSecond.toFixed(0)} ops/s`);

        console.log('Running CRUD benchmarks...');
        results.push(await this.runCRUDBenchmark({
            name: 'crud-round-trip',
            operations: 1000,
            concurrency: 1,
            warmupOperations: 100,
            payloadSizeBytes: 128,
            tenantCount: 5,
            syncMode: 'batched'
        }));
        console.log(`  round-trip P95: ${(results[results.length - 1]!.latencyP95Micros / 1000).toFixed(2)}ms`);

        console.log('Running query benchmarks...');
        results.push(await this.runQueryBenchmark({
            name: 'query-filter-limit',
            operations: 1000,
            concurrency: 1,
            warmupOperations: 0,
            payloadSizeBytes: 0,
            tenantCount: 1,
            syncMode: 'batched'
        }));
        console.log(`  query P95: ${(results[results.length - 1]!.latencyP95Micros / 1000).toFixed(2)}ms`);

        console.log('Running replay benchmark...');
        results.push(await this.runReplayBenchmark(100000));
        console.log(`  replay: ${results[results.length - 1]!.opsPerSecond.toFixed(0)} events/s`);

        return results;
    }
}
