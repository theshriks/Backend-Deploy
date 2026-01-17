/**
 * Partition Manager - Multi-Worker Ingestion with Isolation
 * 
 * Constraints:
 * - Single logical writer per partition
 * - Exactly-once semantics preserved
 * - No cross-partition race conditions
 */

import { Partition, PartitionConfig } from '../contracts/types';

const DEFAULT_PARTITION_COUNT = 16;

/**
 * Fast hash function for partition assignment
 */
function hashString(str: string): number {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i);
    }
    return hash >>> 0;
}

export class PartitionManager {
    private partitions: Partition[] = [];
    private config: PartitionConfig;
    private locks: Map<number, Promise<void>> = new Map();

    constructor(config?: Partial<PartitionConfig>) {
        this.config = {
            partitionCount: config?.partitionCount ?? DEFAULT_PARTITION_COUNT,
            partitionFn: config?.partitionFn ?? ((tenantId) => hashString(tenantId) % this.config.partitionCount)
        };

        // Initialize partitions
        for (let i = 0; i < this.config.partitionCount; i++) {
            this.partitions.push({
                id: i,
                tenantIds: new Set(),
                writerLock: false
            });
        }
    }

    /**
     * Get partition for tenant
     */
    getPartition(tenantId: string): Partition {
        const partitionId = this.config.partitionFn(tenantId);
        const partition = this.partitions[partitionId]!;
        partition.tenantIds.add(tenantId);
        return partition;
    }

    /**
     * Get partition by ID
     */
    getPartitionById(id: number): Partition | undefined {
        return this.partitions[id];
    }

    /**
     * Acquire write lock for partition
     * Ensures single-writer discipline
     */
    async acquireLock(partitionId: number): Promise<() => void> {
        // Wait for any existing lock
        const existingLock = this.locks.get(partitionId);
        if (existingLock) {
            await existingLock;
        }

        const partition = this.partitions[partitionId];
        if (!partition) {
            throw new Error(`Partition ${partitionId} not found`);
        }

        // Create new lock
        let releaseFn: () => void;
        const lockPromise = new Promise<void>(resolve => {
            releaseFn = resolve;
        });

        this.locks.set(partitionId, lockPromise);
        partition.writerLock = true;

        // Return release function
        return () => {
            partition.writerLock = false;
            this.locks.delete(partitionId);
            releaseFn!();
        };
    }

    /**
     * Try to acquire lock without waiting
     */
    tryAcquireLock(partitionId: number): (() => void) | null {
        const partition = this.partitions[partitionId];
        if (!partition || partition.writerLock) {
            return null;
        }

        partition.writerLock = true;

        return () => {
            partition.writerLock = false;
        };
    }

    /**
     * Get partition statistics
     */
    getStats(): {
        partitionCount: number;
        tenantsPerPartition: number[];
        lockedPartitions: number;
    } {
        return {
            partitionCount: this.partitions.length,
            tenantsPerPartition: this.partitions.map(p => p.tenantIds.size),
            lockedPartitions: this.partitions.filter(p => p.writerLock).length
        };
    }
}

/**
 * Batch Coordinator - Partition-aware batching
 */
export class BatchCoordinator<T> {
    private batches: Map<number, T[]> = new Map();
    private partitionManager: PartitionManager;
    private batchSize: number;
    private onFlush: (partitionId: number, batch: T[]) => Promise<void>;

    constructor(
        partitionManager: PartitionManager,
        batchSize: number,
        onFlush: (partitionId: number, batch: T[]) => Promise<void>
    ) {
        this.partitionManager = partitionManager;
        this.batchSize = batchSize;
        this.onFlush = onFlush;
    }

    /**
     * Add item to partition batch
     */
    async add(tenantId: string, item: T): Promise<void> {
        const partition = this.partitionManager.getPartition(tenantId);

        let batch = this.batches.get(partition.id);
        if (!batch) {
            batch = [];
            this.batches.set(partition.id, batch);
        }

        batch.push(item);

        // Flush if batch is full
        if (batch.length >= this.batchSize) {
            await this.flushPartition(partition.id);
        }
    }

    /**
     * Flush specific partition
     */
    async flushPartition(partitionId: number): Promise<void> {
        const batch = this.batches.get(partitionId);
        if (!batch || batch.length === 0) return;

        // Acquire lock
        const release = await this.partitionManager.acquireLock(partitionId);

        try {
            // Get batch and clear
            const toFlush = [...batch];
            batch.length = 0;

            // Process
            await this.onFlush(partitionId, toFlush);
        } finally {
            release();
        }
    }

    /**
     * Flush all partitions
     */
    async flushAll(): Promise<void> {
        const flushPromises: Promise<void>[] = [];

        for (const [partitionId] of this.batches) {
            flushPromises.push(this.flushPartition(partitionId));
        }

        await Promise.all(flushPromises);
    }

    /**
     * Get pending counts
     */
    getPending(): Map<number, number> {
        const result = new Map<number, number>();
        for (const [partitionId, batch] of this.batches) {
            result.set(partitionId, batch.length);
        }
        return result;
    }
}

/**
 * Worker Pool for parallel processing
 */
export class WorkerPool<T, R> {
    private workers: number;
    private queue: { item: T; resolve: (r: R) => void; reject: (e: Error) => void }[] = [];
    private activeWorkers = 0;
    private processor: (item: T) => Promise<R>;

    constructor(workers: number, processor: (item: T) => Promise<R>) {
        this.workers = workers;
        this.processor = processor;
    }

    /**
     * Submit work item
     */
    submit(item: T): Promise<R> {
        return new Promise((resolve, reject) => {
            this.queue.push({ item, resolve, reject });
            this.tryProcess();
        });
    }

    private tryProcess(): void {
        while (this.activeWorkers < this.workers && this.queue.length > 0) {
            const work = this.queue.shift()!;
            this.activeWorkers++;

            this.processor(work.item)
                .then(result => {
                    work.resolve(result);
                    this.activeWorkers--;
                    this.tryProcess();
                })
                .catch(error => {
                    work.reject(error instanceof Error ? error : new Error(String(error)));
                    this.activeWorkers--;
                    this.tryProcess();
                });
        }
    }

    /**
     * Submit batch and wait for all
     */
    async submitBatch(items: T[]): Promise<R[]> {
        return Promise.all(items.map(item => this.submit(item)));
    }

    /**
     * Get stats
     */
    getStats(): { activeWorkers: number; queueLength: number; maxWorkers: number } {
        return {
            activeWorkers: this.activeWorkers,
            queueLength: this.queue.length,
            maxWorkers: this.workers
        };
    }
}
