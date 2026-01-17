/**
 * Index Engine - Hash and Range Indexes for Fast Queries
 * 
 * Indexes are derived from projections:
 * - Fully rebuildable
 * - Never persisted separately from WAL
 * - Read-only (queries never mutate state)
 */

import { IndexDefinition, IndexEntry, IndexType } from '../contracts/types';

export class HashIndex {
    private index: Map<string, Set<string>> = new Map(); // key -> entityIds
    readonly name: string;
    readonly field: string;

    constructor(name: string, field: string) {
        this.name = name;
        this.field = field;
    }

    add(key: unknown, entityId: string): void {
        const keyStr = this.normalizeKey(key);
        let set = this.index.get(keyStr);
        if (!set) {
            set = new Set();
            this.index.set(keyStr, set);
        }
        set.add(entityId);
    }

    remove(key: unknown, entityId: string): void {
        const keyStr = this.normalizeKey(key);
        const set = this.index.get(keyStr);
        if (set) {
            set.delete(entityId);
            if (set.size === 0) {
                this.index.delete(keyStr);
            }
        }
    }

    get(key: unknown): Set<string> {
        const keyStr = this.normalizeKey(key);
        return this.index.get(keyStr) || new Set();
    }

    clear(): void {
        this.index.clear();
    }

    private normalizeKey(key: unknown): string {
        if (key === null || key === undefined) return '__null__';
        if (typeof key === 'object') return JSON.stringify(key);
        return String(key);
    }

    get size(): number {
        return this.index.size;
    }
}

export class RangeIndex {
    private entries: { key: number | string; entityId: string }[] = [];
    private sorted = true;
    readonly name: string;
    readonly field: string;

    constructor(name: string, field: string) {
        this.name = name;
        this.field = field;
    }

    add(key: unknown, entityId: string): void {
        if (typeof key !== 'number' && typeof key !== 'string') return;
        this.entries.push({ key: key as number | string, entityId });
        this.sorted = false;
    }

    remove(key: unknown, entityId: string): void {
        const idx = this.entries.findIndex(
            e => e.key === key && e.entityId === entityId
        );
        if (idx >= 0) {
            this.entries.splice(idx, 1);
        }
    }

    private ensureSorted(): void {
        if (!this.sorted) {
            this.entries.sort((a, b) => {
                if (a.key < b.key) return -1;
                if (a.key > b.key) return 1;
                return 0;
            });
            this.sorted = true;
        }
    }

    range(min: number | string, max: number | string, options?: { minInclusive?: boolean; maxInclusive?: boolean }): string[] {
        this.ensureSorted();

        const minInc = options?.minInclusive ?? true;
        const maxInc = options?.maxInclusive ?? true;
        const result: string[] = [];

        for (const entry of this.entries) {
            const aboveMin = minInc ? entry.key >= min : entry.key > min;
            const belowMax = maxInc ? entry.key <= max : entry.key < max;

            if (aboveMin && belowMax) {
                result.push(entry.entityId);
            }
        }

        return result;
    }

    greaterThan(value: number | string, inclusive = false): string[] {
        this.ensureSorted();
        return this.entries
            .filter(e => inclusive ? e.key >= value : e.key > value)
            .map(e => e.entityId);
    }

    lessThan(value: number | string, inclusive = false): string[] {
        this.ensureSorted();
        return this.entries
            .filter(e => inclusive ? e.key <= value : e.key < value)
            .map(e => e.entityId);
    }

    clear(): void {
        this.entries = [];
        this.sorted = true;
    }

    get size(): number {
        return this.entries.length;
    }
}

export class IndexManager {
    private hashIndexes: Map<string, HashIndex> = new Map();
    private rangeIndexes: Map<string, RangeIndex> = new Map();

    createIndex(definition: IndexDefinition): void {
        const key = `${definition.projection}.${definition.name}`;

        if (definition.type === 'hash') {
            this.hashIndexes.set(key, new HashIndex(definition.name, definition.field));
        } else {
            this.rangeIndexes.set(key, new RangeIndex(definition.name, definition.field));
        }
    }

    getHashIndex(projection: string, name: string): HashIndex | undefined {
        return this.hashIndexes.get(`${projection}.${name}`);
    }

    getRangeIndex(projection: string, name: string): RangeIndex | undefined {
        return this.rangeIndexes.get(`${projection}.${name}`);
    }

    indexEntity(projection: string, entityId: string, data: Record<string, unknown>): void {
        // Update hash indexes
        for (const [key, index] of this.hashIndexes) {
            if (key.startsWith(`${projection}.`)) {
                const value = this.getNestedValue(data, index.field);
                if (value !== undefined) {
                    index.add(value, entityId);
                }
            }
        }

        // Update range indexes
        for (const [key, index] of this.rangeIndexes) {
            if (key.startsWith(`${projection}.`)) {
                const value = this.getNestedValue(data, index.field);
                if (value !== undefined) {
                    index.add(value, entityId);
                }
            }
        }
    }

    removeEntity(projection: string, entityId: string, data: Record<string, unknown>): void {
        for (const [key, index] of this.hashIndexes) {
            if (key.startsWith(`${projection}.`)) {
                const value = this.getNestedValue(data, index.field);
                if (value !== undefined) {
                    index.remove(value, entityId);
                }
            }
        }

        for (const [key, index] of this.rangeIndexes) {
            if (key.startsWith(`${projection}.`)) {
                const value = this.getNestedValue(data, index.field);
                if (value !== undefined) {
                    index.remove(value, entityId);
                }
            }
        }
    }

    private getNestedValue(obj: Record<string, unknown>, path: string): unknown {
        const parts = path.split('.');
        let current: unknown = obj;

        for (const part of parts) {
            if (current === null || current === undefined) return undefined;
            if (typeof current !== 'object') return undefined;
            current = (current as Record<string, unknown>)[part];
        }

        return current;
    }

    clearAll(): void {
        for (const index of this.hashIndexes.values()) {
            index.clear();
        }
        for (const index of this.rangeIndexes.values()) {
            index.clear();
        }
    }

    getStats(): { hashIndexCount: number; rangeIndexCount: number } {
        return {
            hashIndexCount: this.hashIndexes.size,
            rangeIndexCount: this.rangeIndexes.size
        };
    }
}
