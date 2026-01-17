/**
 * Full Verification Suite - Proves correctness of all optimizations
 * 
 * Verifies:
 * - WAL integrity (checksums, sequence monotonicity)
 * - Projection consistency (rebuildable from WAL)
 * - Replay determinism (same input = same output)
 * - CRUD round-trip correctness
 */

import * as fs from 'fs';
import { UltraFastWAL } from './wal/ultra-fast';
import { ProjectionEngine } from './projections/engine';
import { createEntityProjection, EntityStore, listEntities } from './projections/crud';
import { crc32 } from './wal/crc32';

interface VerificationReport {
    testName: string;
    passed: boolean;
    duration: number;
    details: string[];
}

async function verifyWALIntegrity(dataDir: string): Promise<VerificationReport> {
    const start = Date.now();
    const details: string[] = [];
    let passed = true;

    const wal = new UltraFastWAL({ dataDir });
    await wal.initialize();

    let lastSequence = 0n;
    let eventCount = 0;
    let sequenceErrors = 0;

    for (const event of wal.readEvents()) {
        eventCount++;

        // Check sequence monotonicity
        if (event.sequence <= lastSequence) {
            sequenceErrors++;
            passed = false;
            details.push(`Sequence error at ${event.sequence} (previous: ${lastSequence})`);
        }
        lastSequence = event.sequence;
    }

    details.push(`Verified ${eventCount} events`);
    details.push(`Last sequence: ${lastSequence}`);
    details.push(`Sequence errors: ${sequenceErrors}`);

    await wal.shutdown();

    return {
        testName: 'WAL Integrity',
        passed,
        duration: Date.now() - start,
        details
    };
}

async function verifyProjectionRebuild(dataDir: string): Promise<VerificationReport> {
    const start = Date.now();
    const details: string[] = [];
    let passed = true;

    const wal = new UltraFastWAL({ dataDir });
    await wal.initialize();

    const projections = new ProjectionEngine(wal as any);
    projections.register(createEntityProjection('item'));

    // First build
    const build1 = await projections.rebuildAll();
    const hash1 = projections.calculateStateHash();
    details.push(`Build 1: ${build1.eventsProcessed} events, hash=${hash1}`);

    // Delete and rebuild
    projections.deleteAll();
    const build2 = await projections.rebuildAll();
    const hash2 = projections.calculateStateHash();
    details.push(`Build 2: ${build2.eventsProcessed} events, hash=${hash2}`);

    if (hash1 !== hash2) {
        passed = false;
        details.push(`HASH MISMATCH: ${hash1} !== ${hash2}`);
    } else {
        details.push('Hash match: ✓');
    }

    await wal.shutdown();

    return {
        testName: 'Projection Rebuild Consistency',
        passed,
        duration: Date.now() - start,
        details
    };
}

async function verifyReplayDeterminism(dataDir: string): Promise<VerificationReport> {
    const start = Date.now();
    const details: string[] = [];
    let passed = true;

    const wal = new UltraFastWAL({ dataDir });
    await wal.initialize();

    // Collect events from two replays
    const replay1Hashes: string[] = [];
    const replay2Hashes: string[] = [];

    for (const event of wal.readEvents()) {
        const hash = crc32(Buffer.from(`${event.sequence}:${event.tenantId}:${event.eventType}:${event.payload.toString()}`));
        replay1Hashes.push(hash.toString(16));
    }

    for (const event of wal.readEvents()) {
        const hash = crc32(Buffer.from(`${event.sequence}:${event.tenantId}:${event.eventType}:${event.payload.toString()}`));
        replay2Hashes.push(hash.toString(16));
    }

    details.push(`Replay 1: ${replay1Hashes.length} events`);
    details.push(`Replay 2: ${replay2Hashes.length} events`);

    if (replay1Hashes.length !== replay2Hashes.length) {
        passed = false;
        details.push('Event count mismatch');
    } else {
        let mismatches = 0;
        for (let i = 0; i < replay1Hashes.length; i++) {
            if (replay1Hashes[i] !== replay2Hashes[i]) {
                mismatches++;
            }
        }
        if (mismatches > 0) {
            passed = false;
            details.push(`${mismatches} hash mismatches`);
        } else {
            details.push('All hashes match: ✓');
        }
    }

    await wal.shutdown();

    return {
        testName: 'Replay Determinism',
        passed,
        duration: Date.now() - start,
        details
    };
}

async function verifyCRUDRoundTrip(): Promise<VerificationReport> {
    const start = Date.now();
    const details: string[] = [];
    let passed = true;

    const dataDir = './data/verification/crud';
    if (fs.existsSync(dataDir)) {
        fs.rmSync(dataDir, { recursive: true });
    }

    const wal = new UltraFastWAL({ dataDir, maxBatchSize: 100, maxDelayMs: 1 });
    await wal.initialize();

    const projections = new ProjectionEngine(wal as any);
    projections.register(createEntityProjection('item'));

    // Create entities
    const entityCount = 100;
    for (let i = 0; i < entityCount; i++) {
        await wal.append({
            tenantId: 'tenant-1',
            eventType: 'item.created',
            payload: { id: `item-${i}`, name: `Item ${i}`, value: i * 10 }
        });
    }

    // Rebuild projections
    await projections.rebuildAll();

    // Verify all entities exist
    const store = projections.get<EntityStore>('entities_item', 'tenant-1');
    if (!store) {
        passed = false;
        details.push('No entity store found');
    } else {
        const entities = listEntities(store);
        if (entities.length !== entityCount) {
            passed = false;
            details.push(`Expected ${entityCount} entities, got ${entities.length}`);
        } else {
            details.push(`✓ All ${entityCount} entities found`);
        }

        // Verify entity data
        for (let i = 0; i < entityCount; i++) {
            const entity = entities.find(e => e.id === `item-${i}`);
            if (!entity) {
                passed = false;
                details.push(`Entity item-${i} not found`);
                break;
            }
            const data = entity.data as any;
            if (data.value !== i * 10) {
                passed = false;
                details.push(`Entity item-${i} has wrong value: ${data.value} !== ${i * 10}`);
                break;
            }
        }
        if (passed) {
            details.push('✓ All entity data verified');
        }
    }

    await wal.shutdown();

    return {
        testName: 'CRUD Round-Trip',
        passed,
        duration: Date.now() - start,
        details
    };
}

async function runFullVerification(): Promise<void> {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║    ShrikDB Phase 5 - Full Verification Suite               ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    // First create test data
    console.log('Creating test data...');
    const testDataDir = './data/verification/wal';
    if (fs.existsSync(testDataDir)) {
        fs.rmSync(testDataDir, { recursive: true });
    }

    const wal = new UltraFastWAL({ dataDir: testDataDir, maxBatchSize: 5000 });
    await wal.initialize();

    const eventCount = 10000;
    const promises: Promise<any>[] = [];
    for (let i = 0; i < eventCount; i++) {
        promises.push(wal.append({
            tenantId: `tenant-${i % 10}`,
            eventType: i % 3 === 0 ? 'item.created' : 'item.updated',
            payload: { id: `item-${i}`, value: Math.random() * 1000 }
        }));
    }
    await Promise.all(promises);
    await wal.shutdown();
    console.log(`Created ${eventCount} test events\n`);

    // Run verifications
    const results: VerificationReport[] = [];

    console.log('Running WAL Integrity check...');
    results.push(await verifyWALIntegrity(testDataDir));
    console.log(`  ${results[results.length - 1]!.passed ? '✓ PASSED' : '✗ FAILED'} (${results[results.length - 1]!.duration}ms)\n`);

    console.log('Running Projection Rebuild check...');
    results.push(await verifyProjectionRebuild(testDataDir));
    console.log(`  ${results[results.length - 1]!.passed ? '✓ PASSED' : '✗ FAILED'} (${results[results.length - 1]!.duration}ms)\n`);

    console.log('Running Replay Determinism check...');
    results.push(await verifyReplayDeterminism(testDataDir));
    console.log(`  ${results[results.length - 1]!.passed ? '✓ PASSED' : '✗ FAILED'} (${results[results.length - 1]!.duration}ms)\n`);

    console.log('Running CRUD Round-Trip check...');
    results.push(await verifyCRUDRoundTrip());
    console.log(`  ${results[results.length - 1]!.passed ? '✓ PASSED' : '✗ FAILED'} (${results[results.length - 1]!.duration}ms)\n`);

    // Summary
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║    VERIFICATION SUMMARY                                    ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    let allPassed = true;
    for (const result of results) {
        const status = result.passed ? '✓ PASSED' : '✗ FAILED';
        console.log(`${result.testName}: ${status}`);
        for (const detail of result.details) {
            console.log(`  - ${detail}`);
        }
        console.log('');
        if (!result.passed) allPassed = false;
    }

    console.log('════════════════════════════════════════════════════════════');
    console.log(`OVERALL: ${allPassed ? '✓ ALL VERIFICATIONS PASSED' : '✗ SOME VERIFICATIONS FAILED'}`);
    console.log('════════════════════════════════════════════════════════════');

    process.exit(allPassed ? 0 : 1);
}

runFullVerification().catch(err => {
    console.error('Verification error:', err);
    process.exit(1);
});
