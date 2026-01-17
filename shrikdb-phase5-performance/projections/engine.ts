/**
 * Projection Engine - Read-Optimized Views Derived from WAL
 * 
 * Rules:
 * - Projections are FULLY rebuildable from WAL
 * - Projections are disposable (can be deleted)
 * - Projections are isolated per tenant
 * - WAL remains the single source of truth
 */

import { WALEvent, Projection, ProjectionDefinition } from '../contracts/types';
import { HighPerformanceWAL } from '../wal/engine';

export class ProjectionEngine {
    private definitions: Map<string, ProjectionDefinition> = new Map();
    private projections: Map<string, Map<string, Projection>> = new Map(); // name -> tenantId -> projection
    private wal: HighPerformanceWAL;
    private lastAppliedSequence = 0n;

    // Metrics
    private rebuildCount = 0;
    private totalRebuildTimeMs = 0;

    constructor(wal: HighPerformanceWAL) {
        this.wal = wal;
    }

    /**
     * Register a projection definition
     */
    register<T>(definition: ProjectionDefinition<T>): void {
        this.definitions.set(definition.name, definition as ProjectionDefinition);
        this.projections.set(definition.name, new Map());
    }

    /**
     * Rebuild all projections from WAL
     */
    async rebuildAll(): Promise<{ eventsProcessed: number; durationMs: number }> {
        const startTime = Date.now();
        let eventsProcessed = 0;

        // Clear all projections
        for (const projMap of this.projections.values()) {
            projMap.clear();
        }
        this.lastAppliedSequence = 0n;

        // Replay WAL
        for (const event of this.wal.readEvents()) {
            this.applyEvent(event);
            eventsProcessed++;
        }

        const durationMs = Date.now() - startTime;
        this.rebuildCount++;
        this.totalRebuildTimeMs += durationMs;

        return { eventsProcessed, durationMs };
    }

    /**
     * Rebuild single projection from WAL
     */
    async rebuildProjection(name: string): Promise<{ eventsProcessed: number; durationMs: number }> {
        const definition = this.definitions.get(name);
        if (!definition) {
            throw new Error(`Projection ${name} not registered`);
        }

        const startTime = Date.now();
        let eventsProcessed = 0;

        // Clear this projection
        const projMap = this.projections.get(name);
        if (projMap) {
            projMap.clear();
        }

        // Replay WAL
        for (const event of this.wal.readEvents()) {
            this.applyEventToProjection(name, definition, event);
            eventsProcessed++;
        }

        const durationMs = Date.now() - startTime;
        this.rebuildCount++;
        this.totalRebuildTimeMs += durationMs;

        return { eventsProcessed, durationMs };
    }

    /**
     * Apply new event to all projections
     */
    applyEvent(event: WALEvent): void {
        for (const [name, definition] of this.definitions) {
            this.applyEventToProjection(name, definition, event);
        }
        this.lastAppliedSequence = event.sequence;
    }

    private applyEventToProjection(name: string, definition: ProjectionDefinition, event: WALEvent): void {
        let projMap = this.projections.get(name);
        if (!projMap) {
            projMap = new Map();
            this.projections.set(name, projMap);
        }

        let projection = projMap.get(event.tenantId);
        if (!projection) {
            projection = {
                name,
                tenantId: event.tenantId,
                lastSequence: 0n,
                data: definition.init(),
                updatedAt: Date.now()
            };
            projMap.set(event.tenantId, projection);
        }

        // Apply event (MUST be deterministic)
        projection.data = definition.apply(projection.data, event);
        projection.lastSequence = event.sequence;
        projection.updatedAt = Date.now();
    }

    /**
     * Get projection for tenant
     */
    get<T>(name: string, tenantId: string): T | undefined {
        const projMap = this.projections.get(name);
        if (!projMap) return undefined;

        const projection = projMap.get(tenantId);
        return projection?.data as T;
    }

    /**
     * Get all projections for a name
     */
    getAll<T>(name: string): Map<string, T> {
        const result = new Map<string, T>();
        const projMap = this.projections.get(name);

        if (projMap) {
            for (const [tenantId, projection] of projMap) {
                result.set(tenantId, projection.data as T);
            }
        }

        return result;
    }

    /**
     * Delete all projections (can be rebuilt from WAL)
     */
    deleteAll(): void {
        for (const projMap of this.projections.values()) {
            projMap.clear();
        }
        this.lastAppliedSequence = 0n;
    }

    /**
     * Delete projections for a specific tenant
     */
    deleteForTenant(tenantId: string): void {
        for (const projMap of this.projections.values()) {
            projMap.delete(tenantId);
        }
    }

    /**
     * Get metrics
     */
    getMetrics(): {
        projectionCount: number;
        totalRebuildCount: number;
        avgRebuildTimeMs: number;
        lastAppliedSequence: bigint;
    } {
        let count = 0;
        for (const projMap of this.projections.values()) {
            count += projMap.size;
        }

        return {
            projectionCount: count,
            totalRebuildCount: this.rebuildCount,
            avgRebuildTimeMs: this.rebuildCount > 0 ? this.totalRebuildTimeMs / this.rebuildCount : 0,
            lastAppliedSequence: this.lastAppliedSequence
        };
    }

    /**
     * Calculate hash of all projection states (for verification)
     */
    calculateStateHash(): string {
        const states: string[] = [];

        for (const [name, projMap] of this.projections) {
            for (const [tenantId, projection] of projMap) {
                states.push(`${name}:${tenantId}:${projection.lastSequence}:${JSON.stringify(projection.data)}`);
            }
        }

        states.sort();

        // Simple hash
        let hash = 0;
        const str = states.join('|');
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }

        return hash.toString(16);
    }
}
