/**
 * ShrikDB Phase 5 Performance - Core Types
 * High-performance types preserving all architectural guarantees
 */

// ============================================================================
// SYNC MODES - Durability vs Throughput Tradeoffs
// ============================================================================

export type SyncMode = 'immediate' | 'batched' | 'periodic';

export interface SyncModeConfig {
    mode: SyncMode;
    /** Batch size for 'batched' mode */
    batchSize: number;
    /** Max delay in ms before forced flush for 'batched' mode */
    maxDelayMs: number;
    /** Sync interval for 'periodic' mode */
    syncIntervalMs: number;
}

// ============================================================================
// WAL TYPES
// ============================================================================

export interface WALEvent {
    sequence: bigint;
    timestamp: number; // Unix timestamp in microseconds
    tenantId: string;
    eventType: string;
    payload: Buffer; // Pre-serialized payload for speed
    checksum: number;
}

export interface WALEventInput {
    tenantId: string;
    eventType: string;
    payload: Record<string, unknown>;
}

export interface WALAppendResult {
    sequence: bigint;
    latencyMicros: number;
}

export interface WALConfig {
    dataDir: string;
    syncMode: SyncModeConfig;
    segmentSizeBytes: number;
    writeBufferSizeBytes: number;
    enableChecksums: boolean;
}

// ============================================================================
// PROJECTION TYPES
// ============================================================================

export interface Projection<T = unknown> {
    name: string;
    tenantId: string;
    lastSequence: bigint;
    data: T;
    updatedAt: number;
}

export interface ProjectionDefinition<T = unknown> {
    name: string;
    /** Initial state factory */
    init: () => T;
    /** Apply event to state - MUST be deterministic */
    apply: (state: T, event: WALEvent) => T;
    /** Optional: Extract indexed fields */
    getIndexKeys?: (state: T) => Record<string, unknown>;
}

// ============================================================================
// INDEX TYPES
// ============================================================================

export type IndexType = 'hash' | 'range';

export interface IndexDefinition {
    name: string;
    projection: string;
    field: string;
    type: IndexType;
}

export interface IndexEntry {
    key: unknown;
    tenantId: string;
    entityId: string;
    sequence: bigint;
}

// ============================================================================
// QUERY TYPES
// ============================================================================

export type ComparisonOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';

export interface QueryFilter {
    field: string;
    op: ComparisonOp;
    value: unknown;
}

export interface QueryOptions {
    tenantId: string;
    projection: string;
    filters?: QueryFilter[];
    sort?: { field: string; order: 'asc' | 'desc' };
    limit?: number;
    offset?: number;
}

export interface AggregateOptions {
    tenantId: string;
    projection: string;
    operation: 'count' | 'sum' | 'min' | 'max' | 'avg';
    field?: string;
    filters?: QueryFilter[];
}

// ============================================================================
// PARTITION TYPES
// ============================================================================

export interface Partition {
    id: number;
    tenantIds: Set<string>;
    writerLock: boolean;
}

export interface PartitionConfig {
    partitionCount: number;
    partitionFn: (tenantId: string) => number;
}

// ============================================================================
// METRICS TYPES
// ============================================================================

export interface PerformanceMetrics {
    walMetrics: {
        totalEvents: bigint;
        totalBytes: bigint;
        eventsPerSecond: number;
        bytesPerSecond: number;
        pendingBatch: number;
        fsyncCount: number;
        avgWriteLatencyMicros: number;
        p50LatencyMicros: number;
        p95LatencyMicros: number;
        p99LatencyMicros: number;
    };
    projectionMetrics: {
        totalProjections: number;
        rebuildCount: number;
        avgRebuildTimeMs: number;
        lastRebuildSequence: bigint;
    };
    queryMetrics: {
        totalQueries: number;
        avgQueryTimeMs: number;
        p95QueryTimeMs: number;
    };
    memoryMetrics: {
        heapUsedBytes: number;
        writeBufferBytes: number;
        projectionCacheBytes: number;
    };
}

// ============================================================================
// BENCHMARK TYPES
// ============================================================================

export interface BenchmarkConfig {
    name: string;
    operations: number;
    concurrency: number;
    warmupOperations: number;
    payloadSizeBytes: number;
    tenantCount: number;
    syncMode: SyncMode;
}

export interface BenchmarkResult {
    name: string;
    config: BenchmarkConfig;
    startedAt: string;
    completedAt: string;
    durationMs: number;
    opsPerSecond: number;
    latencyP50Micros: number;
    latencyP95Micros: number;
    latencyP99Micros: number;
    latencyMaxMicros: number;
    throughputMBps: number;
    fsyncCount: number;
    memoryUsedMB: number;
    invariantsValid: boolean;
    errors: string[];
}

// ============================================================================
// VERIFICATION TYPES
// ============================================================================

export interface VerificationResult {
    passed: boolean;
    verificationType: string;
    eventsVerified: bigint;
    checksumErrors: number;
    sequenceGaps: number;
    replayDeterministic: boolean;
    projectionHashMatch: boolean;
    durationMs: number;
    details: string[];
}
