/**
 * ShrikDB Phase 5 Performance - Main Entry Point
 */

// Contracts
export * from './contracts/types';

// WAL
export { HighPerformanceWAL } from './wal/engine';
export { WALSegment, listSegments } from './wal/segment';
export { crc32, CRC32Stream } from './wal/crc32';
export { WriteBuffer, EventRingBuffer } from './wal/buffer';

// Projections
export { ProjectionEngine } from './projections/engine';
export { createEntityProjection, getEntity, listEntities, Entity, EntityStore } from './projections/crud';

// Indexing
export { HashIndex, RangeIndex, IndexManager } from './indexing/engine';

// Queries
export { QueryEngine, QueryResult, AggregateResult } from './queries/engine';

// Concurrency
export { PartitionManager, BatchCoordinator, WorkerPool } from './concurrency/partitions';

// Benchmarks
export { BenchmarkRunner } from './benchmarks/runner';

// Verification
export { VerificationEngine, runVerification } from './verification/engine';
