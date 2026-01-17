/**
 * ShrikDB Phase 5 - Main Entry Point
 * Exports all public APIs for integration
 */

// Contracts
export * from './contracts/types';

// WAL Engine
export { WALEngine } from './wal/engine';
export { crc32, crc32String, verifyCrc32, combineCrc32 } from './wal/crc32';
export {
    createSegment,
    openSegmentForReading,
    readNextEvent,
    closeSegmentReader,
    listSegmentFiles,
    verifySegment
} from './wal/segment';

// Snapshot Engine
export { SnapshotEngine } from './snapshot/engine';

// Benchmark Runner
export { BenchmarkRunner } from './benchmark/runner';

// Metrics Exporter
export { MetricsExporter } from './metrics/exporter';

// Verification Engine
export { VerificationEngine, runVerification } from './verification/engine';
