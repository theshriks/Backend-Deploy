#!/usr/bin/env node
/**
 * ShrikDB CLI - Command Line Tools
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';

import { WALEngine } from '../wal/engine';
import { listSegmentFiles, verifySegment, openSegmentForReading, readNextEvent, closeSegmentReader } from '../wal/segment';
import { SnapshotEngine } from '../snapshot/engine';
import { BenchmarkRunner } from '../benchmark/runner';
import { MetricsExporter } from '../metrics/exporter';
import { VerificationEngine, runVerification } from '../verification/engine';

const program = new Command();

program
    .name('shrikdb')
    .description('ShrikDB CLI Tools')
    .version('1.0.0');

// ============================================================================
// WAL Commands
// ============================================================================

const walCommand = program.command('wal').description('WAL operations');

walCommand
    .command('inspect')
    .description('Inspect WAL segments')
    .option('-d, --data-dir <dir>', 'Data directory', './data/wal')
    .option('-s, --segment <id>', 'Specific segment ID to inspect')
    .option('-n, --limit <count>', 'Limit number of events to show', '10')
    .action(async (options) => {
        const segmentFiles = listSegmentFiles(options.dataDir);

        if (segmentFiles.length === 0) {
            console.log('No WAL segments found.');
            return;
        }

        console.log(`Found ${segmentFiles.length} segment(s):\n`);

        for (const filePath of segmentFiles) {
            const fileName = path.basename(filePath);
            const stats = fs.statSync(filePath);

            try {
                const reader = openSegmentForReading(filePath);
                const seg = reader.segment;

                console.log(`Segment: ${fileName}`);
                console.log(`  ID: ${seg.segmentId}`);
                console.log(`  Sealed: ${seg.sealed}`);
                console.log(`  Size: ${(stats.size / 1024).toFixed(2)} KB`);
                console.log(`  Start Seq: ${seg.startSequence}`);
                console.log(`  End Seq: ${seg.endSequence ?? 'N/A'}`);
                console.log(`  Created: ${seg.createdAt}`);

                if (seg.sealed) {
                    console.log(`  Sealed At: ${seg.sealedAt}`);
                }

                // Show sample events
                const limit = parseInt(options.limit);
                let count = 0;
                console.log(`\n  Sample Events (first ${limit}):`);

                while (count < limit) {
                    const event = readNextEvent(reader);
                    if (!event) break;

                    console.log(`    [${event.sequence}] ${event.tenantId}:${event.eventType} @ ${event.timestamp}`);
                    count++;
                }

                closeSegmentReader(reader);
                console.log('');
            } catch (error) {
                console.error(`  Error reading segment: ${error}`);
            }
        }
    });

walCommand
    .command('verify')
    .description('Verify WAL integrity')
    .option('-d, --data-dir <dir>', 'Data directory', './data/wal')
    .action(async (options) => {
        console.log('Verifying WAL integrity...\n');

        const segmentFiles = listSegmentFiles(options.dataDir);
        let totalEvents = 0;
        let totalErrors = 0;

        for (const filePath of segmentFiles) {
            const result = verifySegment(filePath);
            const fileName = path.basename(filePath);

            if (result.valid) {
                console.log(`✓ ${fileName}: ${result.eventCount} events OK`);
            } else {
                console.log(`✗ ${fileName}: ${result.errors.length} errors`);
                result.errors.forEach(e => console.log(`    - ${e}`));
                totalErrors += result.errors.length;
            }

            totalEvents += result.eventCount;
        }

        console.log(`\nTotal: ${totalEvents} events, ${totalErrors} errors`);

        if (totalErrors === 0) {
            console.log('\n✓ WAL integrity verified');
        } else {
            console.log('\n✗ WAL integrity check FAILED');
            process.exit(1);
        }
    });

walCommand
    .command('stats')
    .description('Show WAL statistics')
    .option('-d, --data-dir <dir>', 'Data directory', './data/wal')
    .action(async (options) => {
        const walEngine = new WALEngine({ dataDir: options.dataDir });
        await walEngine.initialize();

        const metrics = walEngine.getMetrics();

        console.log('WAL Statistics:');
        console.log(`  Total Events: ${metrics.totalEvents}`);
        console.log(`  Total Bytes: ${(Number(metrics.totalBytesWritten) / 1024 / 1024).toFixed(2)} MB`);
        console.log(`  Current Segment: ${metrics.currentSegmentId}`);
        console.log(`  Sealed Segments: ${metrics.sealedSegments}`);
        console.log(`  Write Latency P50: ${metrics.writeLatencyP50} µs`);
        console.log(`  Write Latency P95: ${metrics.writeLatencyP95} µs`);
        console.log(`  Write Latency P99: ${metrics.writeLatencyP99} µs`);

        await walEngine.shutdown();
    });

// ============================================================================
// Snapshot Commands
// ============================================================================

const snapshotCommand = program.command('snapshot').description('Snapshot operations');

snapshotCommand
    .command('create')
    .description('Create a new snapshot')
    .option('-d, --data-dir <dir>', 'Data directory', './data')
    .action(async (options) => {
        console.log('Creating snapshot...');

        const walEngine = new WALEngine({ dataDir: `${options.dataDir}/wal` });
        await walEngine.initialize();

        const snapshotEngine = new SnapshotEngine(walEngine, `${options.dataDir}/snapshots`);
        const metadata = await snapshotEngine.createSnapshot();

        console.log('Snapshot created:');
        console.log(`  ID: ${metadata.snapshotId}`);
        console.log(`  Sequence: ${metadata.upToSequence}`);
        console.log(`  Size: ${(metadata.sizeBytes / 1024).toFixed(2)} KB`);
        console.log(`  Path: ${metadata.filePath}`);

        await walEngine.shutdown();
    });

snapshotCommand
    .command('list')
    .description('List available snapshots')
    .option('-d, --data-dir <dir>', 'Data directory', './data')
    .action(async (options) => {
        const walEngine = new WALEngine({ dataDir: `${options.dataDir}/wal` });
        await walEngine.initialize();

        const snapshotEngine = new SnapshotEngine(walEngine, `${options.dataDir}/snapshots`);
        const snapshots = await snapshotEngine.listSnapshots();

        if (snapshots.length === 0) {
            console.log('No snapshots found.');
        } else {
            console.log('Snapshots:');
            for (const s of snapshots) {
                console.log(`  ${s.snapshotId}`);
                console.log(`    Sequence: ${s.upToSequence}`);
                console.log(`    Created: ${s.createdAt}`);
                console.log(`    Size: ${(s.sizeBytes / 1024).toFixed(2)} KB`);
                console.log('');
            }
        }

        await walEngine.shutdown();
    });

snapshotCommand
    .command('restore <snapshotId>')
    .description('Restore from snapshot')
    .option('-d, --data-dir <dir>', 'Data directory', './data')
    .action(async (snapshotId, options) => {
        console.log(`Restoring from snapshot ${snapshotId}...`);

        const walEngine = new WALEngine({ dataDir: `${options.dataDir}/wal` });
        await walEngine.initialize();

        const snapshotEngine = new SnapshotEngine(walEngine, `${options.dataDir}/snapshots`);
        const state = await snapshotEngine.restoreFromSnapshot(snapshotId);

        console.log('Restored state:');
        console.log(`  Last Sequence: ${state.lastSequence}`);
        console.log(`  Tenants: ${state.tenants.size}`);

        for (const [id, tenant] of state.tenants) {
            console.log(`    ${id}: ${tenant.eventCount} events`);
        }

        await walEngine.shutdown();
    });

// ============================================================================
// Benchmark Commands
// ============================================================================

const benchmarkCommand = program.command('benchmark').description('Benchmark operations');

benchmarkCommand
    .command('run')
    .description('Run benchmarks')
    .option('-d, --data-dir <dir>', 'Data directory', './data/benchmark')
    .option('-n, --name <name>', 'Specific benchmark to run')
    .option('-o, --output <file>', 'Output results to file')
    .action(async (options) => {
        const runner = new BenchmarkRunner(options.dataDir);
        let results;

        if (options.name) {
            const configs = runner.getAvailableBenchmarks();
            const config = configs.find(c => c.name === options.name);

            if (!config) {
                console.error(`Benchmark "${options.name}" not found.`);
                console.log('Available benchmarks:', configs.map(c => c.name).join(', '));
                process.exit(1);
            }

            console.log(`Running benchmark: ${options.name}...`);
            const result = await runner.runBenchmark(config);
            results = [result];
        } else {
            console.log('Running all benchmarks...\n');
            results = await runner.runAllBenchmarks();
        }

        console.log('\n=== Benchmark Results ===\n');

        for (const r of results) {
            console.log(`${r.name}:`);
            console.log(`  Duration: ${r.durationMs.toFixed(2)} ms`);
            console.log(`  Ops/sec: ${r.opsPerSecond.toFixed(2)}`);
            console.log(`  Latency P50: ${r.latencyP50Micros} µs`);
            console.log(`  Latency P95: ${r.latencyP95Micros} µs`);
            console.log(`  Latency P99: ${r.latencyP99Micros} µs`);
            console.log(`  Throughput: ${r.throughputMBps.toFixed(2)} MB/s`);
            console.log(`  Invariants: ${r.invariantsValid ? '✓ PASSED' : '✗ FAILED'}`);

            if (r.errors.length > 0) {
                console.log(`  Errors: ${r.errors.length}`);
            }
            console.log('');
        }

        if (options.output) {
            fs.writeFileSync(options.output, JSON.stringify(results, (_, v) =>
                typeof v === 'bigint' ? v.toString() : v, 2));
            console.log(`Results saved to ${options.output}`);
        }
    });

benchmarkCommand
    .command('list')
    .description('List available benchmarks')
    .action(() => {
        const runner = new BenchmarkRunner();
        const configs = runner.getAvailableBenchmarks();

        console.log('Available benchmarks:');
        for (const c of configs) {
            console.log(`  ${c.name}`);
            console.log(`    Operations: ${c.operations}`);
            console.log(`    Concurrency: ${c.concurrency}`);
            console.log(`    Payload Size: ${c.payloadSizeBytes} bytes`);
            console.log('');
        }
    });

// ============================================================================
// Metrics Commands
// ============================================================================

program
    .command('metrics')
    .description('Export metrics')
    .option('-d, --data-dir <dir>', 'Data directory', './data')
    .option('-f, --format <format>', 'Output format (json, prometheus)', 'json')
    .action(async (options) => {
        const walEngine = new WALEngine({ dataDir: `${options.dataDir}/wal` });
        await walEngine.initialize();

        const snapshotEngine = new SnapshotEngine(walEngine, `${options.dataDir}/snapshots`);
        const exporter = new MetricsExporter();

        exporter.setWALEngine(walEngine);
        exporter.setSnapshotEngine(snapshotEngine);

        if (options.format === 'prometheus') {
            console.log(exporter.exportPrometheus());
        } else {
            console.log(exporter.exportJSON());
        }

        await walEngine.shutdown();
    });

// ============================================================================
// Verify Command
// ============================================================================

program
    .command('verify')
    .description('Run full verification suite')
    .option('-d, --data-dir <dir>', 'Data directory', './data')
    .option('--delete-projections', 'Delete projections before verification')
    .action(async (options) => {
        console.log('Running full verification suite...\n');

        if (options.deleteProjections) {
            const projectionsDir = `${options.dataDir}/projections`;
            if (fs.existsSync(projectionsDir)) {
                fs.rmSync(projectionsDir, { recursive: true });
                console.log('Deleted projections directory.\n');
            }
        }

        const result = await runVerification(options.dataDir);

        console.log('Verification Results:');
        console.log(`  Type: ${result.verificationType}`);
        console.log(`  Passed: ${result.passed ? '✓ YES' : '✗ NO'}`);
        console.log(`  Duration: ${result.durationMs} ms`);
        console.log(`  Events Verified: ${result.details.eventsVerified}`);
        console.log(`  Segments Verified: ${result.details.segmentsVerified}`);
        console.log(`  Checksum Errors: ${result.details.checksumErrors}`);
        console.log(`  Replay Mismatches: ${result.details.replayMismatches}`);
        console.log(`  Snapshot Drift: ${result.details.snapshotDrift}`);

        if (result.errors.length > 0) {
            console.log('\nErrors:');
            result.errors.forEach(e => console.log(`  - ${e}`));
        }

        if (!result.passed) {
            process.exit(1);
        }
    });

program.parse();
