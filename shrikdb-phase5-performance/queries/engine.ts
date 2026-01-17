/**
 * Query Engine - Mongo-like Queries on Projections
 * 
 * Rules:
 * - Queries NEVER mutate state
 * - Queries NEVER bypass event sourcing
 * - Query results must be provably derivable from WAL
 */

import { QueryOptions, QueryFilter, AggregateOptions, ComparisonOp } from '../contracts/types';
import { ProjectionEngine } from '../projections/engine';
import { EntityStore, Entity, getEntity, listEntities } from '../projections/crud';
import { IndexManager } from '../indexing/engine';

export interface QueryResult<T = unknown> {
    data: T[];
    count: number;
    durationMs: number;
}

export interface AggregateResult {
    value: number;
    durationMs: number;
}

export class QueryEngine {
    private projections: ProjectionEngine;
    private indexes: IndexManager;

    // Metrics
    private queryCount = 0;
    private totalQueryTimeMs = 0;

    constructor(projections: ProjectionEngine, indexes: IndexManager) {
        this.projections = projections;
        this.indexes = indexes;
    }

    /**
     * Find entities matching filters
     */
    find<T extends Entity = Entity>(options: QueryOptions): QueryResult<T> {
        const startTime = performance.now();

        // Get entity store
        const store = this.projections.get<EntityStore>(options.projection, options.tenantId);
        if (!store) {
            return { data: [], count: 0, durationMs: 0 };
        }

        // Start with all entities
        let entities = listEntities(store);

        // Apply filters
        if (options.filters && options.filters.length > 0) {
            entities = this.applyFilters(entities, options.filters);
        }

        const totalCount = entities.length;

        // Apply sort
        if (options.sort) {
            entities = this.applySort(entities, options.sort.field, options.sort.order);
        }

        // Apply pagination
        if (options.offset) {
            entities = entities.slice(options.offset);
        }
        if (options.limit) {
            entities = entities.slice(0, options.limit);
        }

        const durationMs = performance.now() - startTime;
        this.queryCount++;
        this.totalQueryTimeMs += durationMs;

        return {
            data: entities as T[],
            count: totalCount,
            durationMs
        };
    }

    /**
     * Find one entity by ID
     */
    findById<T extends Entity = Entity>(
        projection: string,
        tenantId: string,
        id: string
    ): T | undefined {
        const store = this.projections.get<EntityStore>(projection, tenantId);
        if (!store) return undefined;
        return getEntity(store, id) as T | undefined;
    }

    /**
     * Find entities using index
     */
    findByIndex<T extends Entity = Entity>(
        projection: string,
        tenantId: string,
        indexName: string,
        value: unknown
    ): T[] {
        const startTime = performance.now();

        const store = this.projections.get<EntityStore>(projection, tenantId);
        if (!store) return [];

        // Try hash index first
        const hashIndex = this.indexes.getHashIndex(projection, indexName);
        if (hashIndex) {
            const ids = hashIndex.get(value);
            const entities: T[] = [];
            for (const id of ids) {
                const entity = getEntity(store, id);
                if (entity) {
                    entities.push(entity as T);
                }
            }
            return entities;
        }

        // Fallback to range index for equality
        const rangeIndex = this.indexes.getRangeIndex(projection, indexName);
        if (rangeIndex && (typeof value === 'number' || typeof value === 'string')) {
            const ids = rangeIndex.range(value, value);
            const entities: T[] = [];
            for (const id of ids) {
                const entity = getEntity(store, id);
                if (entity) {
                    entities.push(entity as T);
                }
            }
            return entities;
        }

        return [];
    }

    /**
     * Find entities in range (using range index)
     */
    findByRange<T extends Entity = Entity>(
        projection: string,
        tenantId: string,
        indexName: string,
        min: number | string,
        max: number | string
    ): T[] {
        const store = this.projections.get<EntityStore>(projection, tenantId);
        if (!store) return [];

        const rangeIndex = this.indexes.getRangeIndex(projection, indexName);
        if (!rangeIndex) return [];

        const ids = rangeIndex.range(min, max);
        const entities: T[] = [];

        for (const id of ids) {
            const entity = getEntity(store, id);
            if (entity) {
                entities.push(entity as T);
            }
        }

        return entities;
    }

    /**
     * Aggregate functions
     */
    aggregate(options: AggregateOptions): AggregateResult {
        const startTime = performance.now();

        const store = this.projections.get<EntityStore>(options.projection, options.tenantId);
        if (!store) {
            return { value: 0, durationMs: 0 };
        }

        let entities = listEntities(store);

        // Apply filters
        if (options.filters && options.filters.length > 0) {
            entities = this.applyFilters(entities, options.filters);
        }

        let value = 0;

        switch (options.operation) {
            case 'count':
                value = entities.length;
                break;

            case 'sum':
                if (options.field) {
                    value = entities.reduce((acc, e) => {
                        const val = this.getFieldValue(e, options.field!);
                        return acc + (typeof val === 'number' ? val : 0);
                    }, 0);
                }
                break;

            case 'min':
                if (options.field && entities.length > 0) {
                    value = entities.reduce((min, e) => {
                        const val = this.getFieldValue(e, options.field!) as number;
                        return typeof val === 'number' && val < min ? val : min;
                    }, Infinity);
                }
                break;

            case 'max':
                if (options.field && entities.length > 0) {
                    value = entities.reduce((max, e) => {
                        const val = this.getFieldValue(e, options.field!) as number;
                        return typeof val === 'number' && val > max ? val : max;
                    }, -Infinity);
                }
                break;

            case 'avg':
                if (options.field && entities.length > 0) {
                    const sum = entities.reduce((acc, e) => {
                        const val = this.getFieldValue(e, options.field!) as number;
                        return acc + (typeof val === 'number' ? val : 0);
                    }, 0);
                    value = sum / entities.length;
                }
                break;
        }

        const durationMs = performance.now() - startTime;

        return { value, durationMs };
    }

    private applyFilters(entities: Entity[], filters: QueryFilter[]): Entity[] {
        return entities.filter(entity => {
            return filters.every(filter => this.matchFilter(entity, filter));
        });
    }

    private matchFilter(entity: Entity, filter: QueryFilter): boolean {
        const value = this.getFieldValue(entity, filter.field);

        switch (filter.op) {
            case 'eq':
                return value === filter.value;
            case 'ne':
                return value !== filter.value;
            case 'gt':
                return typeof value === 'number' && typeof filter.value === 'number' && value > filter.value;
            case 'gte':
                return typeof value === 'number' && typeof filter.value === 'number' && value >= filter.value;
            case 'lt':
                return typeof value === 'number' && typeof filter.value === 'number' && value < filter.value;
            case 'lte':
                return typeof value === 'number' && typeof filter.value === 'number' && value <= filter.value;
            case 'in':
                return Array.isArray(filter.value) && filter.value.includes(value);
            default:
                return false;
        }
    }

    private applySort(entities: Entity[], field: string, order: 'asc' | 'desc'): Entity[] {
        const multiplier = order === 'desc' ? -1 : 1;

        return [...entities].sort((a, b) => {
            const aVal = this.getFieldValue(a, field);
            const bVal = this.getFieldValue(b, field);

            // Handle comparison for sortable types
            if (typeof aVal === 'number' && typeof bVal === 'number') {
                return (aVal - bVal) * multiplier;
            }
            if (typeof aVal === 'string' && typeof bVal === 'string') {
                return aVal.localeCompare(bVal) * multiplier;
            }
            // Fallback
            const aStr = String(aVal ?? '');
            const bStr = String(bVal ?? '');
            return aStr.localeCompare(bStr) * multiplier;
        });
    }

    private getFieldValue(entity: Entity, field: string): unknown {
        // Handle nested fields like "data.name"
        const parts = field.split('.');
        let current: unknown = entity;

        for (const part of parts) {
            if (current === null || current === undefined) return undefined;
            if (typeof current !== 'object') return undefined;
            current = (current as Record<string, unknown>)[part];
        }

        return current;
    }

    /**
     * Get query metrics
     */
    getMetrics(): { queryCount: number; avgQueryTimeMs: number; p95QueryTimeMs: number } {
        return {
            queryCount: this.queryCount,
            avgQueryTimeMs: this.queryCount > 0 ? this.totalQueryTimeMs / this.queryCount : 0,
            p95QueryTimeMs: 0 // Would need to track individual times
        };
    }
}
