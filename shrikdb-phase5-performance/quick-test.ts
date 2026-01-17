/**
 * Quick Performance Test - Measure raw throughput
 */

import * as fs from 'fs';
import { UltraFastWAL } from './wal/ultra-fast';

async function runQuickTest(): Promise<void> {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║    ShrikDB Phase 5 - Quick Performance Test                ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    const dataDir = './data/quick-test';
    if (fs.existsSync(dataDir)) {
        fs.rmSync(dataDir, { recursive: true });
    }

    // Test 1: Batched mode throughput
    console.log('Test 1: Batched Mode Throughput');
    console.log('--------------------------------');

    const wal1 = new UltraFastWAL({
        dataDir: dataDir + '/batched',
        bufferSizeKB: 8192,
        maxBatchSize: 10000,
        maxDelayMs: 1,
        syncMode: 'batched'
    });

    await wal1.initialize();

    const count1 = 100000;
    const payload1 = { data: 'x'.repeat(64), value: Math.random() };
    const start1 = Date.now();

    const promises1: Promise<void>[] = [];
    for (let i = 0; i < count1; i++) {
        promises1.push(
            wal1.append({
                tenantId: `tenant-${i % 10}`,
                eventType: 'test',
                payload: payload1
            }).then(() => { })
        );
    }

    await Promise.all(promises1);

    const elapsed1 = Date.now() - start1;
    const opsPerSec1 = (count1 / elapsed1) * 1000;

    console.log(`  Events:     ${count1.toLocaleString()}`);
    console.log(`  Duration:   ${elapsed1} ms`);
    console.log(`  Throughput: ${opsPerSec1.toFixed(0)} ops/sec`);
    console.log(`  Fsyncs:     ${wal1.getMetrics().fsyncCount}`);

    await wal1.shutdown();

    // Test 2: Durable mode with micro-batching (group commit)
    console.log('\nTest 2: Durable Mode (Micro-batch Group Commit)');
    console.log('----------------------------------------------');

    const wal2 = new UltraFastWAL({
        dataDir: dataDir + '/durable',
        bufferSizeKB: 1024,
        maxBatchSize: 500,  // Small batches for low latency
        maxDelayMs: 1,      // Very short delay
        syncMode: 'batched' // Batched gives durability with group commit
    });

    await wal2.initialize();

    const count2 = 20000;
    const start2 = Date.now();

    // Concurrent writes - they'll share fsyncs
    const promises2: Promise<void>[] = [];
    for (let i = 0; i < count2; i++) {
        promises2.push(
            wal2.append({
                tenantId: `tenant-${i % 10}`,
                eventType: 'test',
                payload: { index: i }
            }).then(() => { })
        );
    }

    await Promise.all(promises2);

    const elapsed2 = Date.now() - start2;
    const opsPerSec2 = (count2 / elapsed2) * 1000;

    console.log(`  Events:     ${count2.toLocaleString()}`);
    console.log(`  Duration:   ${elapsed2} ms`);
    console.log(`  Throughput: ${opsPerSec2.toFixed(0)} ops/sec`);
    console.log(`  Fsyncs:     ${wal2.getMetrics().fsyncCount}`);

    await wal2.shutdown();

    // Test 3: Replay speed
    console.log('\nTest 3: Replay Speed');
    console.log('--------------------');

    const wal3 = new UltraFastWAL({ dataDir: dataDir + '/batched' });
    await wal3.initialize();

    const start3 = Date.now();
    let replayCount = 0;

    for (const event of wal3.readEvents()) {
        replayCount++;
    }

    const elapsed3 = Date.now() - start3;
    const replayPerSec = (replayCount / elapsed3) * 1000;

    console.log(`  Events:     ${replayCount.toLocaleString()}`);
    console.log(`  Duration:   ${elapsed3} ms`);
    console.log(`  Throughput: ${replayPerSec.toFixed(0)} events/sec`);

    await wal3.shutdown();

    // Summary
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║    SUMMARY                                                 ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    const targets = {
        batched: 50000,
        durable: 10000,
        replay: 100000
    };

    console.log(`Batched Write:  ${opsPerSec1 >= targets.batched ? '✓' : '✗'} ${opsPerSec1.toFixed(0)} ops/sec (target: ≥${targets.batched})`);
    console.log(`Durable Write:  ${opsPerSec2 >= targets.durable ? '✓' : '✗'} ${opsPerSec2.toFixed(0)} ops/sec (target: ≥${targets.durable})`);
    console.log(`Replay:         ${replayPerSec >= targets.replay ? '✓' : '✗'} ${replayPerSec.toFixed(0)} events/sec (target: ≥${targets.replay})`);
}

runQuickTest().catch(console.error);
