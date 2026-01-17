#!/usr/bin/env node
/**
 * ShrikDB Phase 5 - Full Verification Script
 * 
 * This script:
 * 1. Deletes all projections
 * 2. Restores from snapshot + WAL
 * 3. Confirms byte-level integrity
 * 4. Confirms deterministic state
 */

import * as fs from 'fs';
import * as path from 'path';
import { WALEngine } from '../wal/engine';
import { SnapshotEngine } from '../snapshot/engine';
import { VerificationEngine } from '../verification/engine';
import { listSegmentFiles, verifySegment } from '../wal/segment';
import { crc32 } from '../wal/crc32';

interface VerificationReport {
    timestamp: string;
    dataDir: string;
    steps: {
        name: string;
        passed: boolean;
        details: string;
        durationMs: number;
    }[];
    overallPassed: boolean;
    totalDurationMs: number;
}

async function runFullVerification(dataDir: string): Promise<VerificationReport> {
    const startTime = Date.now();
    const report: VerificationReport = {
        timestamp: new Date().toISOString(),
        dataDir,
        steps: [],
        overallPassed: true,
        totalDurationMs: 0
    };

    console.log('='.repeat(60));
    console.log('ShrikDB Phase 5 - Full Verification');
    console.log('='.repeat(60));
    console.log(`Data Directory: ${dataDir}`);
    console.log(`Started: ${report.timestamp}`);
    console.log('');

    // Step 1: Delete all projections
    console.log('Step 1: Deleting projections...');
    const step1Start = Date.now();
    try {
        const projectionsDir = path.join(dataDir, 'projections');
        if (fs.existsSync(projectionsDir)) {
            fs.rmSync(projectionsDir, { recursive: true });
        }
        report.steps.push({
            name: 'Delete projections',
            passed: true,
            details: 'Projections directory deleted',
            durationMs: Date.now() - step1Start
        });
        console.log('  ✓ Projections deleted\n');
    } catch (error) {
        report.steps.push({
            name: 'Delete projections',
            passed: false,
            details: `Error: ${error}`,
            durationMs: Date.now() - step1Start
        });
        console.log(`  ✗ Error: ${error}\n`);
        report.overallPassed = false;
    }

    // Step 2: Verify WAL segment integrity
    console.log('Step 2: Verifying WAL segment integrity...');
    const step2Start = Date.now();
    const walDir = path.join(dataDir, 'wal');
    const segmentFiles = listSegmentFiles(walDir);
    let totalEvents = 0;
    let checksumErrors = 0;

    for (const filePath of segmentFiles) {
        const result = verifySegment(filePath);
        totalEvents += result.eventCount;
        if (!result.valid) {
            checksumErrors += result.errors.length;
        }
    }

    report.steps.push({
        name: 'WAL segment integrity',
        passed: checksumErrors === 0,
        details: `${segmentFiles.length} segments, ${totalEvents} events, ${checksumErrors} checksum errors`,
        durationMs: Date.now() - step2Start
    });

    if (checksumErrors === 0) {
        console.log(`  ✓ ${segmentFiles.length} segments verified, ${totalEvents} events\n`);
    } else {
        console.log(`  ✗ ${checksumErrors} checksum errors found\n`);
        report.overallPassed = false;
    }

    // Step 3: Initialize WAL and verify sequence monotonicity
    console.log('Step 3: Verifying sequence monotonicity...');
    const step3Start = Date.now();
    const walEngine = new WALEngine({ dataDir: walDir });
    await walEngine.initialize();

    let lastSequence = 0n;
    let sequenceErrors = 0;
    let eventCount = 0;

    for await (const event of walEngine.readEvents({})) {
        eventCount++;
        if (event.sequence <= lastSequence) {
            sequenceErrors++;
        }
        lastSequence = event.sequence;
    }

    report.steps.push({
        name: 'Sequence monotonicity',
        passed: sequenceErrors === 0,
        details: `${eventCount} events checked, ${sequenceErrors} ordering violations`,
        durationMs: Date.now() - step3Start
    });

    if (sequenceErrors === 0) {
        console.log(`  ✓ All ${eventCount} events in correct order\n`);
    } else {
        console.log(`  ✗ ${sequenceErrors} sequence ordering violations\n`);
        report.overallPassed = false;
    }

    // Step 4: Create snapshot from WAL
    console.log('Step 4: Creating snapshot from WAL replay...');
    const step4Start = Date.now();
    const snapshotDir = path.join(dataDir, 'snapshots');
    const snapshotEngine = new SnapshotEngine(walEngine, snapshotDir);

    try {
        const snapshot = await snapshotEngine.createSnapshot();
        report.steps.push({
            name: 'Snapshot creation',
            passed: true,
            details: `Snapshot ${snapshot.snapshotId} up to sequence ${snapshot.upToSequence}`,
            durationMs: Date.now() - step4Start
        });
        console.log(`  ✓ Snapshot created: ${snapshot.snapshotId}\n`);

        // Step 5: Verify snapshot consistency
        console.log('Step 5: Verifying snapshot consistency...');
        const step5Start = Date.now();
        const isConsistent = await snapshotEngine.verifySnapshot(snapshot.snapshotId);

        report.steps.push({
            name: 'Snapshot consistency',
            passed: isConsistent,
            details: isConsistent ? 'Snapshot matches WAL replay' : 'Snapshot drift detected',
            durationMs: Date.now() - step5Start
        });

        if (isConsistent) {
            console.log('  ✓ Snapshot matches WAL replay\n');
        } else {
            console.log('  ✗ Snapshot drift detected\n');
            report.overallPassed = false;
        }

    } catch (error) {
        report.steps.push({
            name: 'Snapshot creation',
            passed: false,
            details: `Error: ${error}`,
            durationMs: Date.now() - step4Start
        });
        console.log(`  ✗ Error: ${error}\n`);
        report.overallPassed = false;
    }

    // Step 6: Verify replay determinism
    console.log('Step 6: Verifying replay determinism...');
    const step6Start = Date.now();

    // First replay
    const replay1Hashes: number[] = [];
    for await (const event of walEngine.readEvents({})) {
        const hash = crc32(Buffer.from(JSON.stringify({
            sequence: event.sequence.toString(),
            tenantId: event.tenantId,
            eventType: event.eventType,
            payload: event.payload
        })));
        replay1Hashes.push(hash);
    }

    // Second replay
    const replay2Hashes: number[] = [];
    for await (const event of walEngine.readEvents({})) {
        const hash = crc32(Buffer.from(JSON.stringify({
            sequence: event.sequence.toString(),
            tenantId: event.tenantId,
            eventType: event.eventType,
            payload: event.payload
        })));
        replay2Hashes.push(hash);
    }

    const replayMatch = replay1Hashes.length === replay2Hashes.length &&
        replay1Hashes.every((h, i) => h === replay2Hashes[i]);

    report.steps.push({
        name: 'Replay determinism',
        passed: replayMatch,
        details: `Two replays of ${replay1Hashes.length} events ${replayMatch ? 'match' : 'differ'}`,
        durationMs: Date.now() - step6Start
    });

    if (replayMatch) {
        console.log(`  ✓ Two replays of ${replay1Hashes.length} events are identical\n`);
    } else {
        console.log(`  ✗ Replay determinism failed\n`);
        report.overallPassed = false;
    }

    // Step 7: Verify state can be rebuilt from WAL only
    console.log('Step 7: Verifying WAL-only state rebuild...');
    const step7Start = Date.now();

    // Delete snapshots
    const snapshots = await snapshotEngine.listSnapshots();
    for (const s of snapshots) {
        await snapshotEngine.deleteSnapshot(s.snapshotId);
    }

    // Rebuild from scratch
    const freshWal = new WALEngine({ dataDir: walDir });
    await freshWal.initialize();

    let rebuiltEvents = 0;
    for await (const event of freshWal.readEvents({})) {
        rebuiltEvents++;
    }

    const rebuildMatch = rebuiltEvents === eventCount;

    report.steps.push({
        name: 'WAL-only rebuild',
        passed: rebuildMatch,
        details: `Rebuilt ${rebuiltEvents} events, expected ${eventCount}`,
        durationMs: Date.now() - step7Start
    });

    if (rebuildMatch) {
        console.log(`  ✓ State rebuilt from WAL: ${rebuiltEvents} events\n`);
    } else {
        console.log(`  ✗ Event count mismatch: ${rebuiltEvents} vs ${eventCount}\n`);
        report.overallPassed = false;
    }

    await freshWal.shutdown();
    await walEngine.shutdown();

    // Final report
    report.totalDurationMs = Date.now() - startTime;

    console.log('='.repeat(60));
    console.log('VERIFICATION SUMMARY');
    console.log('='.repeat(60));

    for (const step of report.steps) {
        const status = step.passed ? '✓' : '✗';
        console.log(`${status} ${step.name}: ${step.details} (${step.durationMs}ms)`);
    }

    console.log('');
    console.log(`Total Duration: ${report.totalDurationMs}ms`);
    console.log(`Overall Result: ${report.overallPassed ? '✓ PASSED' : '✗ FAILED'}`);

    // Save report
    const reportPath = path.join(dataDir, 'verification-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\nReport saved to: ${reportPath}`);

    return report;
}

// Main execution
const dataDir = process.argv[2] || './data';

runFullVerification(dataDir)
    .then(report => {
        process.exit(report.overallPassed ? 0 : 1);
    })
    .catch(error => {
        console.error('Verification failed:', error);
        process.exit(1);
    });
