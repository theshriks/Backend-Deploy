/**
 * Verification Engine - Integrity and determinism verification
 */

import * as fs from 'fs';
import {
    VerificationResult,
    IVerificationEngine,
    WALEvent
} from '../contracts/types';
import { WALEngine } from '../wal/engine';
import { SnapshotEngine } from '../snapshot/engine';
import {
    listSegmentFiles,
    verifySegment,
    openSegmentForReading,
    readNextEvent,
    closeSegmentReader
} from '../wal/segment';

export class VerificationEngine implements IVerificationEngine {
    private walEngine: WALEngine;
    private snapshotEngine: SnapshotEngine;
    private dataDir: string;

    constructor(walEngine: WALEngine, snapshotEngine: SnapshotEngine, dataDir: string) {
        this.walEngine = walEngine;
        this.snapshotEngine = snapshotEngine;
        this.dataDir = dataDir;
    }

    async verifyWALIntegrity(): Promise<VerificationResult> {
        const startTime = Date.now();
        const errors: string[] = [];
        let eventsVerified = 0n;
        let segmentsVerified = 0;
        let checksumErrors = 0;

        const segmentFiles = listSegmentFiles(this.dataDir);

        for (const filePath of segmentFiles) {
            const result = verifySegment(filePath);
            segmentsVerified++;

            if (!result.valid) {
                checksumErrors += result.errors.length;
                errors.push(...result.errors.map(e => `${filePath}: ${e}`));
            }

            eventsVerified += BigInt(result.eventCount);
        }

        // Verify sequence monotonicity
        let lastSequence = 0n;
        try {
            for await (const event of this.walEngine.readEvents({})) {
                if (event.sequence <= lastSequence) {
                    errors.push(`Sequence monotonicity violated: ${lastSequence} -> ${event.sequence}`);
                }
                lastSequence = event.sequence;
            }
        } catch (error) {
            errors.push(`Read error: ${error instanceof Error ? error.message : String(error)}`);
        }

        const durationMs = Date.now() - startTime;

        return {
            passed: errors.length === 0,
            verificationType: 'wal-integrity',
            details: {
                eventsVerified,
                segmentsVerified,
                checksumErrors,
                replayMismatches: 0,
                snapshotDrift: false
            },
            durationMs,
            verifiedAt: new Date().toISOString(),
            errors
        };
    }

    async verifySnapshotConsistency(snapshotId: string): Promise<VerificationResult> {
        const startTime = Date.now();
        const errors: string[] = [];
        let eventsVerified = 0n;
        let replayMismatches = 0;
        let snapshotDrift = false;

        try {
            // Get snapshot state
            const snapshotState = await this.snapshotEngine.restoreFromSnapshot(snapshotId);

            // Rebuild state from WAL up to same sequence
            const rebuiltState = await this.rebuildStateFromWAL(snapshotState.lastSequence);
            eventsVerified = snapshotState.lastSequence;

            // Compare tenant counts
            if (snapshotState.tenants.size !== rebuiltState.tenants.size) {
                errors.push(`Tenant count mismatch: snapshot=${snapshotState.tenants.size}, rebuilt=${rebuiltState.tenants.size}`);
                snapshotDrift = true;
            }

            // Compare per-tenant event counts
            for (const [tenantId, snapshotTenant] of snapshotState.tenants) {
                const rebuiltTenant = rebuiltState.tenants.get(tenantId);
                if (!rebuiltTenant) {
                    errors.push(`Missing tenant in rebuilt state: ${tenantId}`);
                    replayMismatches++;
                    continue;
                }

                if (snapshotTenant.eventCount !== rebuiltTenant.eventCount) {
                    errors.push(`Event count mismatch for ${tenantId}: snapshot=${snapshotTenant.eventCount}, rebuilt=${rebuiltTenant.eventCount}`);
                    replayMismatches++;
                }
            }

            // Verify snapshot sequence matches
            if (snapshotState.lastSequence !== rebuiltState.lastSequence) {
                errors.push(`Sequence mismatch: snapshot=${snapshotState.lastSequence}, rebuilt=${rebuiltState.lastSequence}`);
                snapshotDrift = true;
            }

        } catch (error) {
            errors.push(`Verification error: ${error instanceof Error ? error.message : String(error)}`);
        }

        const durationMs = Date.now() - startTime;

        return {
            passed: errors.length === 0,
            verificationType: 'snapshot-consistency',
            details: {
                eventsVerified,
                segmentsVerified: 0,
                checksumErrors: 0,
                replayMismatches,
                snapshotDrift
            },
            durationMs,
            verifiedAt: new Date().toISOString(),
            errors
        };
    }

    private async rebuildStateFromWAL(upToSequence: bigint): Promise<{
        lastSequence: bigint;
        tenants: Map<string, { tenantId: string; eventCount: number }>;
    }> {
        const state = {
            lastSequence: 0n,
            tenants: new Map<string, { tenantId: string; eventCount: number }>()
        };

        for await (const event of this.walEngine.readEvents({ toSequence: upToSequence })) {
            state.lastSequence = event.sequence;

            let tenant = state.tenants.get(event.tenantId);
            if (!tenant) {
                tenant = { tenantId: event.tenantId, eventCount: 0 };
                state.tenants.set(event.tenantId, tenant);
            }
            tenant.eventCount++;
        }

        return state;
    }

    async verifyReplayDeterminism(): Promise<VerificationResult> {
        const startTime = Date.now();
        const errors: string[] = [];
        let eventsVerified = 0n;
        let replayMismatches = 0;

        // Perform two independent replays
        const replay1: WALEvent[] = [];
        const replay2: WALEvent[] = [];

        for await (const event of this.walEngine.readEvents({})) {
            replay1.push(event);
        }

        for await (const event of this.walEngine.readEvents({})) {
            replay2.push(event);
        }

        eventsVerified = BigInt(replay1.length);

        // Compare replays
        if (replay1.length !== replay2.length) {
            errors.push(`Replay length mismatch: ${replay1.length} vs ${replay2.length}`);
            replayMismatches++;
        } else {
            for (let i = 0; i < replay1.length; i++) {
                const e1 = replay1[i];
                const e2 = replay2[i];

                if (e1.sequence !== e2.sequence) {
                    errors.push(`Sequence mismatch at index ${i}: ${e1.sequence} vs ${e2.sequence}`);
                    replayMismatches++;
                }

                if (e1.tenantId !== e2.tenantId) {
                    errors.push(`TenantId mismatch at index ${i}: ${e1.tenantId} vs ${e2.tenantId}`);
                    replayMismatches++;
                }

                if (e1.eventType !== e2.eventType) {
                    errors.push(`EventType mismatch at index ${i}: ${e1.eventType} vs ${e2.eventType}`);
                    replayMismatches++;
                }

                if (JSON.stringify(e1.payload) !== JSON.stringify(e2.payload)) {
                    errors.push(`Payload mismatch at index ${i}`);
                    replayMismatches++;
                }

                // Stop reporting after 10 mismatches
                if (replayMismatches >= 10) {
                    errors.push('... and more mismatches');
                    break;
                }
            }
        }

        const durationMs = Date.now() - startTime;

        return {
            passed: errors.length === 0,
            verificationType: 'replay-determinism',
            details: {
                eventsVerified,
                segmentsVerified: 0,
                checksumErrors: 0,
                replayMismatches,
                snapshotDrift: false
            },
            durationMs,
            verifiedAt: new Date().toISOString(),
            errors
        };
    }

    async runFullVerification(): Promise<VerificationResult> {
        const startTime = Date.now();
        const errors: string[] = [];
        let eventsVerified = 0n;
        let segmentsVerified = 0;
        let checksumErrors = 0;
        let replayMismatches = 0;
        let snapshotDrift = false;

        // WAL Integrity
        const walResult = await this.verifyWALIntegrity();
        errors.push(...walResult.errors);
        eventsVerified = walResult.details.eventsVerified;
        segmentsVerified = walResult.details.segmentsVerified;
        checksumErrors = walResult.details.checksumErrors;

        // Replay Determinism
        const replayResult = await this.verifyReplayDeterminism();
        errors.push(...replayResult.errors);
        replayMismatches = replayResult.details.replayMismatches;

        // Snapshot Consistency (if any snapshots exist)
        const snapshots = await this.snapshotEngine.listSnapshots();
        if (snapshots.length > 0) {
            const snapshotResult = await this.verifySnapshotConsistency(snapshots[0].snapshotId);
            errors.push(...snapshotResult.errors);
            snapshotDrift = snapshotResult.details.snapshotDrift;
        }

        const durationMs = Date.now() - startTime;

        return {
            passed: errors.length === 0,
            verificationType: 'full',
            details: {
                eventsVerified,
                segmentsVerified,
                checksumErrors,
                replayMismatches,
                snapshotDrift
            },
            durationMs,
            verifiedAt: new Date().toISOString(),
            errors
        };
    }
}

/**
 * Standalone verification function for CLI
 */
export async function runVerification(dataDir: string): Promise<VerificationResult> {
    const walEngine = new WALEngine({ dataDir: `${dataDir}/wal` });
    await walEngine.initialize();

    const snapshotEngine = new SnapshotEngine(walEngine, `${dataDir}/snapshots`);
    const verificationEngine = new VerificationEngine(walEngine, snapshotEngine, `${dataDir}/wal`);

    const result = await verificationEngine.runFullVerification();

    await walEngine.shutdown();

    return result;
}
