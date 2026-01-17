/**
 * CRUD Projection - Standard entity store derived from WAL
 */

import { WALEvent, ProjectionDefinition } from '../contracts/types';

export interface Entity {
    id: string;
    data: Record<string, unknown>;
    createdAt: number;
    updatedAt: number;
    version: number;
    deleted: boolean;
}

export interface EntityStore {
    entities: Map<string, Entity>;
    count: number;
}

/**
 * Create a CRUD projection definition for an entity type
 */
export function createEntityProjection(entityType: string): ProjectionDefinition<EntityStore> {
    return {
        name: `entities_${entityType}`,

        init: (): EntityStore => ({
            entities: new Map(),
            count: 0
        }),

        apply: (state: EntityStore, event: WALEvent): EntityStore => {
            // Parse payload
            let payload: Record<string, unknown>;
            try {
                payload = JSON.parse(event.payload.toString('utf-8'));
            } catch {
                return state;
            }

            const eventName = event.eventType;

            // Handle CRUD events
            if (eventName === `${entityType}.created` || eventName === `${entityType}.create`) {
                const id = (payload.id as string) || crypto.randomUUID();
                const entity: Entity = {
                    id,
                    data: payload,
                    createdAt: event.timestamp,
                    updatedAt: event.timestamp,
                    version: 1,
                    deleted: false
                };
                state.entities.set(id, entity);
                state.count = state.entities.size;
            }
            else if (eventName === `${entityType}.updated` || eventName === `${entityType}.update`) {
                const id = payload.id as string;
                const existing = state.entities.get(id);
                if (existing && !existing.deleted) {
                    existing.data = { ...existing.data, ...payload };
                    existing.updatedAt = event.timestamp;
                    existing.version++;
                }
            }
            else if (eventName === `${entityType}.deleted` || eventName === `${entityType}.delete`) {
                const id = payload.id as string;
                const existing = state.entities.get(id);
                if (existing) {
                    existing.deleted = true;
                    existing.updatedAt = event.timestamp;
                    state.count = Array.from(state.entities.values()).filter(e => !e.deleted).length;
                }
            }

            return state;
        },

        getIndexKeys: (state: EntityStore): Record<string, unknown> => {
            const keys: Record<string, unknown> = {};
            for (const [id, entity] of state.entities) {
                if (!entity.deleted) {
                    keys[id] = entity.data;
                }
            }
            return keys;
        }
    };
}

/**
 * Helper to get entity by ID from store
 */
export function getEntity(store: EntityStore, id: string): Entity | undefined {
    const entity = store.entities.get(id);
    return entity && !entity.deleted ? entity : undefined;
}

/**
 * Helper to list all entities
 */
export function listEntities(store: EntityStore, options?: {
    limit?: number;
    offset?: number;
    sortBy?: keyof Entity;
    sortOrder?: 'asc' | 'desc';
}): Entity[] {
    let entities = Array.from(store.entities.values())
        .filter(e => !e.deleted);

    // Sort
    if (options?.sortBy) {
        const order = options.sortOrder === 'desc' ? -1 : 1;
        entities.sort((a, b) => {
            const aVal = a[options.sortBy!];
            const bVal = b[options.sortBy!];
            if (aVal < bVal) return -1 * order;
            if (aVal > bVal) return 1 * order;
            return 0;
        });
    }

    // Pagination
    if (options?.offset) {
        entities = entities.slice(options.offset);
    }
    if (options?.limit) {
        entities = entities.slice(0, options.limit);
    }

    return entities;
}
