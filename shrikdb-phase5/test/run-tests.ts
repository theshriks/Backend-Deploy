/**
 * ShrikDB Phase 5 - Test Suite
 * Real tests with real data - no mocks
 */

import * as fs from 'fs';
import * as path from 'path';
import { WALEngine } from '../wal/engine';
import { SnapshotEngine } from '../snapshot/engine';
import { BenchmarkRunner } from '../benchmark/runner';
import { VerificationEngine } from '../verification/engine';
import { crc32, crc32String } from '../wal/crc32';

const TEST_DATA_DIR = './data/test';

interface TestResult {
    name: string;
    passed: boolean;
    durationMs: number;
    error?: string;
}

async function runTest(
    name: string,
    testFn: () => Promise<void>
): Promise<TestResult> {
    const startTime = Date.now();
    try {
        await testFn();
        return {
            name,
            passed: true,
            durationMs: Date.now() - startTime
        };
    } catch (error) {
        return {
            name,
            passed: false,
            durationMs: Date.now() - startTime,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

// Clean test directory
function cleanTestDir(dir: string): void {
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true });
    }
    fs.mkdirSync(dir, { recursive: true });
}

// ============================================================================
// CRC32 Tests
// ============================================================================

async function testCrc32Basic(): Promise<void> {
    const data = Buffer.from('hello world');
    const checksum = crc32(data);

    if (typeof checksum !== 'number') {
        throw new Error('CRC32 should return a number');
    }

    if (checksum === 0) {
        throw new Error('CRC32 should not be zero for non-empty data');
    }

    // Same data should produce same checksum
    const checksum2 = crc32(data);
    if (checksum !== checksum2) {
        throw new Error('CRC32 should be deterministic');
    }
}

async function testCrc32Different(): Promise<void> {
    const data1 = Buffer.from('hello');
    const data2 = Buffer.from('world');

    const checksum1 = crc32(data1);
    const checksum2 = crc32(data2);

    if (checksum1 === checksum2) {
        throw new Error('Different data should produce different checksums');
    }
}

// ============================================================================
// WAL Engine Tests
// ============================================================================

async function testWalAppendAndRead(): Promise<void> {
    const testDir = path.join(TEST_DATA_DIR, 'wal-basic');
    cleanTestDir(testDir);

    const wal = new WALEngine({
        dataDir: testDir,
        syncMode: 'immediate'
    });
    await wal.initialize();

    // Append events
    const result1 = await wal.appendEvent('tenant1', 'test', { value: 1 });
    const result2 = await wal.appendEvent('tenant1', 'test', { value: 2 });
    const result3 = await wal.appendEvent('tenant2', 'test', { value: 3 });

    if (result1.sequence !== 1n) throw new Error('First sequence should be 1');
    if (result2.sequence !== 2n) throw new Error('Second sequence should be 2');
    if (result3.sequence !== 3n) throw new Error('Third sequence should be 3');

    // Read all events
    const events = [];
    for await (const event of wal.readEvents({})) {
        events.push(event);
    }

    if (events.length !== 3) throw new Error(`Expected 3 events, got ${events.length}`);

    await wal.shutdown();
}

async function testWalSequenceMonotonicity(): Promise<void> {
    const testDir = path.join(TEST_DATA_DIR, 'wal-monotonic');
    cleanTestDir(testDir);

    const wal = new WALEngine({
        dataDir: testDir,
        syncMode: 'batch',
        batchSize: 10
    });
    await wal.initialize();

    // Append many events
    const promises = [];
    for (let i = 0; i < 100; i++) {
        promises.push(wal.appendEvent('tenant1', 'test', { index: i }));
    }
    await Promise.all(promises);

    // Verify monotonicity
    let lastSequence = 0n;
    for await (const event of wal.readEvents({})) {
        if (event.sequence <= lastSequence) {
            throw new Error(`Sequence not monotonic: ${lastSequence} -> ${event.sequence}`);
        }
        lastSequence = event.sequence;
    }

    if (lastSequence !== 100n) {
        throw new Error(`Expected last sequence 100, got ${lastSequence}`);
    }

    await wal.shutdown();
}

async function testWalFilterByTenant(): Promise<void> {
    const testDir = path.join(TEST_DATA_DIR, 'wal-filter');
    cleanTestDir(testDir);

    const wal = new WALEngine({ dataDir: testDir, syncMode: 'immediate' });
    await wal.initialize();

    await wal.appendEvent('tenant1', 'test', { value: 1 });
    await wal.appendEvent('tenant2', 'test', { value: 2 });
    await wal.appendEvent('tenant1', 'test', { value: 3 });
    await wal.appendEvent('tenant3', 'test', { value: 4 });

    // Filter by tenant
    const tenant1Events = [];
    for await (const event of wal.readEvents({ tenantId: 'tenant1' })) {
        tenant1Events.push(event);
    }

    if (tenant1Events.length !== 2) {
        throw new Error(`Expected 2 tenant1 events, got ${tenant1Events.length}`);
    }

    await wal.shutdown();
}

async function testWalSegmentRotation(): Promise<void> {
    const testDir = path.join(TEST_DATA_DIR, 'wal-rotation');
    cleanTestDir(testDir);

    // Use small segment size to trigger rotation
    const wal = new WALEngine({
        dataDir: testDir,
        maxSegmentSizeBytes: 1024, // 1KB
        syncMode: 'immediate'
    });
    await wal.initialize();

    // Write enough data to cause rotation
    for (let i = 0; i < 50; i++) {
        await wal.appendEvent('tenant1', 'test', {
            index: i.toString(),
            padding: 'x'.repeat(100)
        });
    }

    const segments = wal.getAllSegments();
    if (segments.length < 2) {
        throw new Error(`Expected segment rotation, got ${segments.length} segments`);
    }

    await wal.shutdown();
}

// ============================================================================
// Snapshot Tests
// ============================================================================

async function testSnapshotCreateAndRestore(): Promise<void> {
    const testDir = path.join(TEST_DATA_DIR, 'snapshot-basic');
    cleanTestDir(testDir);

    const wal = new WALEngine({ dataDir: path.join(testDir, 'wal'), syncMode: 'immediate' });
    await wal.initialize();

    // Add events
    await wal.appendEvent('tenant1', 'test', { value: 1 });
    await wal.appendEvent('tenant1', 'test', { value: 2 });
    await wal.appendEvent('tenant2', 'test', { value: 3 });

    const snapshot = new SnapshotEngine(wal, path.join(testDir, 'snapshots'));

    // Create snapshot
    const metadata = await snapshot.createSnapshot();

    if (metadata.upToSequence !== 3n) {
        throw new Error(`Expected snapshot at sequence 3, got ${metadata.upToSequence}`);
    }

    // Restore snapshot
    const state = await snapshot.restoreFromSnapshot(metadata.snapshotId);

    if (state.lastSequence !== 3n) {
        throw new Error(`Expected restored sequence 3, got ${state.lastSequence}`);
    }

    if (state.tenants.size !== 2) {
        throw new Error(`Expected 2 tenants, got ${state.tenants.size}`);
    }

    await wal.shutdown();
}

async function testSnapshotVerification(): Promise<void> {
    const testDir = path.join(TEST_DATA_DIR, 'snapshot-verify');
    cleanTestDir(testDir);

    const wal = new WALEngine({ dataDir: path.join(testDir, 'wal'), syncMode: 'immediate' });
    await wal.initialize();

    for (let i = 0; i < 10; i++) {
        await wal.appendEvent('tenant1', 'test', { index: i });
    }

    const snapshot = new SnapshotEngine(wal, path.join(testDir, 'snapshots'));
    const metadata = await snapshot.createSnapshot();

    const isValid = await snapshot.verifySnapshot(metadata.snapshotId);

    if (!isValid) {
        throw new Error('Snapshot verification failed');
    }

    await wal.shutdown();
}

// ============================================================================
// Verification Tests
// ============================================================================

async function testReplayDeterminism(): Promise<void> {
    const testDir = path.join(TEST_DATA_DIR, 'verify-determinism');
    cleanTestDir(testDir);

    const walDir = path.join(testDir, 'wal');
    const wal = new WALEngine({ dataDir: walDir, syncMode: 'immediate' });
    await wal.initialize();

    for (let i = 0; i < 50; i++) {
        await wal.appendEvent(`tenant${i % 3}`, 'test', { index: i, rand: Math.random() });
    }

    const snapshot = new SnapshotEngine(wal, path.join(testDir, 'snapshots'));
    const verifier = new VerificationEngine(wal, snapshot, walDir);

    const result = await verifier.verifyReplayDeterminism();

    if (!result.passed) {
        throw new Error(`Replay determinism failed: ${result.errors.join(', ')}`);
    }

    await wal.shutdown();
}

// ============================================================================
// Benchmark Tests
// ============================================================================

async function testBenchmarkRuns(): Promise<void> {
    const testDir = path.join(TEST_DATA_DIR, 'benchmark');
    cleanTestDir(testDir);

    const runner = new BenchmarkRunner(testDir);

    // Run a small benchmark
    const result = await runner.runBenchmark({
        name: 'test-benchmark',
        operations: 100,
        concurrency: 1,
        warmupOperations: 10,
        payloadSizeBytes: 64,
        tenantCount: 1
    });

    if (!result.invariantsValid) {
        throw new Error('Benchmark invariants failed');
    }

    if (result.opsPerSecond <= 0) {
        throw new Error('Benchmark should report positive ops/sec');
    }
}

// ============================================================================
// Run All Tests
// ============================================================================

async function runAllTests(): Promise<void> {
    console.log('='.repeat(60));
    console.log('ShrikDB Phase 5 - Test Suite');
    console.log('='.repeat(60));
    console.log('');

    const tests = [
        // CRC32 Tests
        runTest('CRC32 Basic', testCrc32Basic),
        runTest('CRC32 Different Data', testCrc32Different),

        // WAL Tests
        runTest('WAL Append and Read', testWalAppendAndRead),
        runTest('WAL Sequence Monotonicity', testWalSequenceMonotonicity),
        runTest('WAL Filter by Tenant', testWalFilterByTenant),
        runTest('WAL Segment Rotation', testWalSegmentRotation),

        // Snapshot Tests
        runTest('Snapshot Create and Restore', testSnapshotCreateAndRestore),
        runTest('Snapshot Verification', testSnapshotVerification),

        // Verification Tests
        runTest('Replay Determinism', testReplayDeterminism),

        // Benchmark Tests
        runTest('Benchmark Runs', testBenchmarkRuns),
    ];

    const results = await Promise.all(tests);

    console.log('Results:\n');

    let passed = 0;
    let failed = 0;

    for (const result of results) {
        const status = result.passed ? '✓' : '✗';
        console.log(`${status} ${result.name} (${result.durationMs}ms)`);
        if (result.error) {
            console.log(`    Error: ${result.error}`);
        }

        if (result.passed) {
            passed++;
        } else {
            failed++;
        }
    }

    console.log('');
    console.log('='.repeat(60));
    console.log(`Total: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(60));

    if (failed > 0) {
        process.exit(1);
    }
}

runAllTests().catch(error => {
    console.error('Test suite failed:', error);
    process.exit(1);
});
