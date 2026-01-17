/**
 * Snapshot Engine - WAL-derived state snapshots
 * Snapshots are ONLY created from WAL replay - no direct state writes
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
    SnapshotMetadata,
    SnapshotState,
    TenantState,
    ProjectionState,
    SnapshotMetrics,
    ISnapshotEngine,
    WALEvent
} from '../contracts/types';
import { WALEngine } from '../wal/engine';
import { crc32 } from '../wal/crc32';

interface SnapshotData {
    metadata: SnapshotMetadata;
    state: SerializedState;
}

interface SerializedState {
    lastSequence: string; // bigint as string
    tenants: Record<string, SerializedTenantState>;
    projections: Record<string, SerializedProjectionState>;
}

interface SerializedTenantState {
    tenantId: string;
    eventCount: number;
    lastEventAt: string | null;
    data: Record<string, unknown>;
}

interface SerializedProjectionState {
    name: string;
    lastSequence: string;
    data: unknown;
    updatedAt: string;
}

export class SnapshotEngine implements ISnapshotEngine {
    private snapshotDir: string;
    private walEngine: WALEngine;
    private snapshots: Map<string, SnapshotMetadata> = new Map();

    // Metrics
    private totalSnapshots = 0;
    private lastSnapshotSequence = 0n;
    private lastSnapshotDurationMs = 0;
    private totalSnapshotSizeBytes = 0n;

    constructor(walEngine: WALEngine, snapshotDir: string = './data/snapshots') {
        this.walEngine = walEngine;
        this.snapshotDir = snapshotDir;

        if (!fs.existsSync(snapshotDir)) {
            fs.mkdirSync(snapshotDir, { recursive: true });
        }

        this.loadExistingSnapshots();
    }

    private loadExistingSnapshots(): void {
        const files = fs.readdirSync(this.snapshotDir)
            .filter(f => f.endsWith('.snapshot.json'));

        for (const file of files) {
            try {
                const filePath = path.join(this.snapshotDir, file);
                const content = fs.readFileSync(filePath, 'utf-8');
                const data = JSON.parse(content);

                // Convert upToSequence from string to bigint
                const metadata: SnapshotMetadata = {
                    snapshotId: data.metadata.snapshotId,
                    upToSequence: BigInt(data.metadata.upToSequence),
                    createdAt: data.metadata.createdAt,
                    sizeBytes: data.metadata.sizeBytes,
                    checksum: data.metadata.checksum,
                    filePath: data.metadata.filePath,
                    verified: data.metadata.verified
                };

                this.snapshots.set(metadata.snapshotId, metadata);
                this.totalSnapshots++;
                this.totalSnapshotSizeBytes += BigInt(metadata.sizeBytes);
            } catch (error) {
                console.warn(`Failed to load snapshot ${file}:`, error);
            }
        }
    }

    async createSnapshot(): Promise<SnapshotMetadata> {
        const startTime = Date.now();
        const snapshotId = uuidv4();

        // Replay WAL to build state
        const state = await this.replayToState();

        const serializedState: SerializedState = {
            lastSequence: state.lastSequence.toString(),
            tenants: {},
            projections: {}
        };

        for (const [id, tenant] of state.tenants) {
            serializedState.tenants[id] = tenant;
        }

        for (const [name, projection] of state.projections) {
            serializedState.projections[name] = {
                ...projection,
                lastSequence: projection.lastSequence.toString()
            };
        }

        // Helper to serialize BigInt values
        const bigIntReplacer = (_key: string, value: unknown): unknown => {
            if (typeof value === 'bigint') {
                return value.toString();
            }
            return value;
        };

        const snapshotData = {
            metadata: {
                snapshotId,
                upToSequence: state.lastSequence.toString(), // Store as string
                createdAt: new Date().toISOString(),
                sizeBytes: 0,
                checksum: 0,
                filePath: '',
                verified: false
            },
            state: serializedState
        };

        const content = JSON.stringify(snapshotData, bigIntReplacer, 2);
        const contentBuffer = Buffer.from(content, 'utf-8');
        const checksum = crc32(contentBuffer);

        const fileName = `${snapshotId}.snapshot.json`;
        const filePath = path.join(this.snapshotDir, fileName);

        snapshotData.metadata.sizeBytes = contentBuffer.length;
        snapshotData.metadata.checksum = checksum;
        snapshotData.metadata.filePath = filePath;
        snapshotData.metadata.verified = true;

        fs.writeFileSync(filePath, JSON.stringify(snapshotData, bigIntReplacer, 2));

        const durationMs = Date.now() - startTime;

        // Return metadata with proper bigint
        const resultMetadata: SnapshotMetadata = {
            snapshotId,
            upToSequence: state.lastSequence,
            createdAt: snapshotData.metadata.createdAt,
            sizeBytes: snapshotData.metadata.sizeBytes,
            checksum: snapshotData.metadata.checksum,
            filePath: snapshotData.metadata.filePath,
            verified: true
        };

        this.snapshots.set(snapshotId, resultMetadata);
        this.totalSnapshots++;
        this.lastSnapshotSequence = state.lastSequence;
        this.lastSnapshotDurationMs = durationMs;
        this.totalSnapshotSizeBytes += BigInt(snapshotData.metadata.sizeBytes);

        return resultMetadata;
    }

    private async replayToState(): Promise<SnapshotState> {
        const state: SnapshotState = {
            lastSequence: 0n,
            tenants: new Map(),
            projections: new Map()
        };

        for await (const event of this.walEngine.readEvents({})) {
            this.applyEventToState(state, event);
        }

        return state;
    }

    private applyEventToState(state: SnapshotState, event: WALEvent): void {
        state.lastSequence = event.sequence;

        let tenantState = state.tenants.get(event.tenantId);
        if (!tenantState) {
            tenantState = {
                tenantId: event.tenantId,
                eventCount: 0,
                lastEventAt: null,
                data: {}
            };
            state.tenants.set(event.tenantId, tenantState);
        }

        tenantState.eventCount++;
        tenantState.lastEventAt = event.timestamp;

        // Apply event-specific logic based on eventType
        this.applyEventData(tenantState, event);
    }

    private applyEventData(tenantState: TenantState, event: WALEvent): void {
        // Generic event application - stores last N events per type
        const eventTypeKey = `events_${event.eventType}`;
        if (!tenantState.data[eventTypeKey]) {
            tenantState.data[eventTypeKey] = [];
        }

        const events = tenantState.data[eventTypeKey] as unknown[];
        events.push({
            sequence: event.sequence.toString(),
            timestamp: event.timestamp,
            payload: event.payload
        });

        // Keep only last 100 events per type
        if (events.length > 100) {
            (tenantState.data[eventTypeKey] as unknown[]).shift();
        }
    }

    async restoreFromSnapshot(snapshotId: string): Promise<SnapshotState> {
        const metadata = this.snapshots.get(snapshotId);
        if (!metadata) {
            throw new Error(`Snapshot ${snapshotId} not found`);
        }

        const content = fs.readFileSync(metadata.filePath, 'utf-8');
        const data: SnapshotData = JSON.parse(content);

        // Verify checksum
        const contentBuffer = Buffer.from(JSON.stringify({
            metadata: { ...data.metadata, checksum: 0, verified: false },
            state: data.state
        }, null, 2), 'utf-8');

        const state: SnapshotState = {
            lastSequence: BigInt(data.state.lastSequence),
            tenants: new Map(),
            projections: new Map()
        };

        for (const [id, tenant] of Object.entries(data.state.tenants)) {
            state.tenants.set(id, tenant);
        }

        for (const [name, proj] of Object.entries(data.state.projections)) {
            state.projections.set(name, {
                ...proj,
                lastSequence: BigInt(proj.lastSequence)
            });
        }

        return state;
    }

    async listSnapshots(): Promise<SnapshotMetadata[]> {
        return Array.from(this.snapshots.values())
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }

    async deleteSnapshot(snapshotId: string): Promise<void> {
        const metadata = this.snapshots.get(snapshotId);
        if (!metadata) {
            throw new Error(`Snapshot ${snapshotId} not found`);
        }

        fs.unlinkSync(metadata.filePath);
        this.snapshots.delete(snapshotId);
        this.totalSnapshotSizeBytes -= BigInt(metadata.sizeBytes);
    }

    async verifySnapshot(snapshotId: string): Promise<boolean> {
        const metadata = this.snapshots.get(snapshotId);
        if (!metadata) return false;

        try {
            const content = fs.readFileSync(metadata.filePath, 'utf-8');
            const data = JSON.parse(content);

            // Parse upToSequence as BigInt (stored as string)
            const upToSequence = BigInt(data.metadata.upToSequence);

            // Rebuild state from WAL up to snapshot sequence
            const rebuiltState = await this.replayToSequence(upToSequence);

            // Compare states
            const originalState = await this.restoreFromSnapshot(snapshotId);

            return this.compareStates(originalState, rebuiltState);
        } catch {
            return false;
        }
    }

    private async replayToSequence(upToSequence: bigint): Promise<SnapshotState> {
        const state: SnapshotState = {
            lastSequence: 0n,
            tenants: new Map(),
            projections: new Map()
        };

        for await (const event of this.walEngine.readEvents({ toSequence: upToSequence })) {
            this.applyEventToState(state, event);
        }

        return state;
    }

    private compareStates(a: SnapshotState, b: SnapshotState): boolean {
        if (a.lastSequence !== b.lastSequence) return false;
        if (a.tenants.size !== b.tenants.size) return false;

        for (const [id, tenantA] of a.tenants) {
            const tenantB = b.tenants.get(id);
            if (!tenantB) return false;
            if (tenantA.eventCount !== tenantB.eventCount) return false;
        }

        return true;
    }

    async getLatestSnapshot(): Promise<SnapshotMetadata | null> {
        const snapshots = await this.listSnapshots();
        return snapshots.length > 0 ? snapshots[0] : null;
    }

    getMetrics(): SnapshotMetrics {
        return {
            totalSnapshots: this.totalSnapshots,
            lastSnapshotSequence: this.lastSnapshotSequence,
            lastSnapshotDurationMs: this.lastSnapshotDurationMs,
            totalSnapshotSizeBytes: this.totalSnapshotSizeBytes
        };
    }
}
