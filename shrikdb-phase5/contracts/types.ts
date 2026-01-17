/**
 * ShrikDB Phase 5 - Core Type Definitions
 * These types define the contract between Phase 5 and future Phase 4 integration
 */

// ============================================================================
// WAL TYPES
// ============================================================================

/**
 * Represents a single event in the WAL
 * Events are immutable and append-only
 */
export interface WALEvent {
  /** Unique, monotonically increasing sequence number */
  sequence: bigint;
  /** ISO 8601 timestamp when event was appended */
  timestamp: string;
  /** Tenant identifier for multi-tenant support */
  tenantId: string;
  /** Event type/name for routing and replay */
  eventType: string;
  /** Event payload - must be JSON serializable */
  payload: Record<string, unknown>;
  /** CRC32 checksum of the event data for integrity verification */
  checksum: number;
}

/**
 * WAL Segment - Fixed-size file containing multiple events
 */
export interface WALSegment {
  /** Segment ID (monotonically increasing) */
  segmentId: number;
  /** First sequence number in this segment */
  startSequence: bigint;
  /** Last sequence number in this segment (null if segment is active) */
  endSequence: bigint | null;
  /** Segment file path */
  filePath: string;
  /** Segment size in bytes */
  sizeBytes: number;
  /** Whether this segment is sealed (readonly) */
  sealed: boolean;
  /** Checksum of entire segment for verification */
  segmentChecksum: number | null;
  /** Timestamp when segment was created */
  createdAt: string;
  /** Timestamp when segment was sealed */
  sealedAt: string | null;
}

/**
 * WAL Configuration
 */
export interface WALConfig {
  /** Directory to store WAL segments */
  dataDir: string;
  /** Maximum segment size in bytes (default: 64MB) */
  maxSegmentSizeBytes: number;
  /** Sync mode: 'immediate' | 'batch' | 'periodic' */
  syncMode: 'immediate' | 'batch' | 'periodic';
  /** Batch size for batch sync mode */
  batchSize: number;
  /** Periodic sync interval in milliseconds */
  syncIntervalMs: number;
  /** Enable checksums on events */
  enableChecksums: boolean;
  /** Compression algorithm: 'none' | 'gzip' | 'lz4' */
  compression: 'none' | 'gzip' | 'lz4';
}

/**
 * WAL Append Result
 */
export interface WALAppendResult {
  /** Sequence number assigned to the event */
  sequence: bigint;
  /** Segment ID where event was written */
  segmentId: number;
  /** Byte offset within segment */
  offset: number;
  /** Latency in microseconds */
  latencyMicros: number;
}

/**
 * WAL Read Options
 */
export interface WALReadOptions {
  /** Start sequence (inclusive) */
  fromSequence?: bigint;
  /** End sequence (inclusive) */
  toSequence?: bigint;
  /** Filter by tenant ID */
  tenantId?: string;
  /** Filter by event types */
  eventTypes?: string[];
  /** Maximum number of events to return */
  limit?: number;
}

// ============================================================================
// SNAPSHOT TYPES
// ============================================================================

/**
 * Snapshot Metadata
 */
export interface SnapshotMetadata {
  /** Unique snapshot ID */
  snapshotId: string;
  /** Sequence number up to which this snapshot is valid */
  upToSequence: bigint;
  /** Timestamp when snapshot was created */
  createdAt: string;
  /** Size in bytes */
  sizeBytes: number;
  /** Checksum of snapshot data */
  checksum: number;
  /** Snapshot file path */
  filePath: string;
  /** Whether snapshot is verified */
  verified: boolean;
}

/**
 * Snapshot State - Reconstructed state from WAL replay
 */
export interface SnapshotState {
  /** Last applied sequence number */
  lastSequence: bigint;
  /** Per-tenant state */
  tenants: Map<string, TenantState>;
  /** Global projections */
  projections: Map<string, ProjectionState>;
}

/**
 * Per-Tenant State
 */
export interface TenantState {
  tenantId: string;
  /** Event count for this tenant */
  eventCount: number;
  /** Last event timestamp */
  lastEventAt: string | null;
  /** Custom tenant data built from events */
  data: Record<string, unknown>;
}

/**
 * Projection State - Read-optimized view derived from WAL
 */
export interface ProjectionState {
  /** Projection name */
  name: string;
  /** Last applied sequence */
  lastSequence: bigint;
  /** Projection data */
  data: unknown;
  /** Timestamp of last update */
  updatedAt: string;
}

// ============================================================================
// METRICS TYPES
// ============================================================================

/**
 * WAL Metrics
 */
export interface WALMetrics {
  /** Total events written */
  totalEvents: bigint;
  /** Total bytes written */
  totalBytesWritten: bigint;
  /** Current segment ID */
  currentSegmentId: number;
  /** Number of sealed segments */
  sealedSegments: number;
  /** Write latency histogram (microseconds) */
  writeLatencyP50: number;
  writeLatencyP95: number;
  writeLatencyP99: number;
  /** Events per second (last minute) */
  eventsPerSecond: number;
  /** Bytes per second (last minute) */
  bytesPerSecond: number;
  /** Current batch queue depth */
  batchQueueDepth: number;
  /** Backpressure active */
  backpressureActive: boolean;
}

/**
 * Replay Metrics
 */
export interface ReplayMetrics {
  /** Total events replayed */
  eventsReplayed: bigint;
  /** Replay duration in milliseconds */
  replayDurationMs: number;
  /** Events per second during replay */
  replayEventsPerSecond: number;
  /** Current replay lag (sequence numbers behind head) */
  replayLag: bigint;
}

/**
 * Snapshot Metrics
 */
export interface SnapshotMetrics {
  /** Total snapshots created */
  totalSnapshots: number;
  /** Last snapshot sequence */
  lastSnapshotSequence: bigint;
  /** Last snapshot creation time in ms */
  lastSnapshotDurationMs: number;
  /** Total snapshot size on disk */
  totalSnapshotSizeBytes: bigint;
}

/**
 * System Metrics Bundle
 */
export interface SystemMetrics {
  wal: WALMetrics;
  replay: ReplayMetrics;
  snapshot: SnapshotMetrics;
  /** Timestamp when metrics were collected */
  collectedAt: string;
}

// ============================================================================
// BENCHMARK TYPES
// ============================================================================

/**
 * Benchmark Configuration
 */
export interface BenchmarkConfig {
  /** Benchmark name */
  name: string;
  /** Number of operations */
  operations: number;
  /** Concurrency level (for multi-tenant tests) */
  concurrency: number;
  /** Warmup operations */
  warmupOperations: number;
  /** Event payload size in bytes */
  payloadSizeBytes: number;
  /** Number of tenants for multi-tenant tests */
  tenantCount: number;
}

/**
 * Benchmark Result
 */
export interface BenchmarkResult {
  /** Benchmark name */
  name: string;
  /** Configuration used */
  config: BenchmarkConfig;
  /** Start timestamp */
  startedAt: string;
  /** End timestamp */
  completedAt: string;
  /** Total duration in milliseconds */
  durationMs: number;
  /** Operations per second */
  opsPerSecond: number;
  /** Latency percentiles (microseconds) */
  latencyP50Micros: number;
  latencyP95Micros: number;
  latencyP99Micros: number;
  latencyMaxMicros: number;
  /** Total bytes processed */
  bytesProcessed: bigint;
  /** Throughput in MB/s */
  throughputMBps: number;
  /** Whether benchmark passed invariant checks */
  invariantsValid: boolean;
  /** Error messages if any */
  errors: string[];
  /** Raw latency samples (for histogram) */
  latencySamples: number[];
}

// ============================================================================
// VERIFICATION TYPES
// ============================================================================

/**
 * Verification Result
 */
export interface VerificationResult {
  /** Whether verification passed */
  passed: boolean;
  /** Verification type */
  verificationType: 'wal-integrity' | 'snapshot-consistency' | 'replay-determinism' | 'full';
  /** Details of verification */
  details: {
    eventsVerified: bigint;
    segmentsVerified: number;
    checksumErrors: number;
    replayMismatches: number;
    snapshotDrift: boolean;
  };
  /** Duration in milliseconds */
  durationMs: number;
  /** Timestamp */
  verifiedAt: string;
  /** Error messages */
  errors: string[];
}

// ============================================================================
// INTERFACES (Contracts for Phase 4 Integration)
// ============================================================================

/**
 * WAL Engine Interface
 * This is the contract that Phase 4 will use to interact with the WAL
 */
export interface IWALEngine {
  /** Initialize the WAL engine */
  initialize(): Promise<void>;
  
  /** Append a single event */
  appendEvent(tenantId: string, eventType: string, payload: Record<string, unknown>): Promise<WALAppendResult>;
  
  /** Append multiple events atomically */
  appendEvents(events: Array<{ tenantId: string; eventType: string; payload: Record<string, unknown> }>): Promise<WALAppendResult[]>;
  
  /** Read events from WAL */
  readEvents(options: WALReadOptions): AsyncGenerator<WALEvent, void, unknown>;
  
  /** Get current head sequence */
  getHeadSequence(): bigint;
  
  /** Get WAL metrics */
  getMetrics(): WALMetrics;
  
  /** Force segment rotation */
  rotateSegment(): Promise<void>;
  
  /** Shutdown gracefully */
  shutdown(): Promise<void>;
}

/**
 * Snapshot Engine Interface
 */
export interface ISnapshotEngine {
  /** Create a snapshot at current WAL head */
  createSnapshot(): Promise<SnapshotMetadata>;
  
  /** Restore state from snapshot */
  restoreFromSnapshot(snapshotId: string): Promise<SnapshotState>;
  
  /** List available snapshots */
  listSnapshots(): Promise<SnapshotMetadata[]>;
  
  /** Delete a snapshot */
  deleteSnapshot(snapshotId: string): Promise<void>;
  
  /** Verify snapshot integrity */
  verifySnapshot(snapshotId: string): Promise<boolean>;
  
  /** Get latest snapshot metadata */
  getLatestSnapshot(): Promise<SnapshotMetadata | null>;
  
  /** Get snapshot metrics */
  getMetrics(): SnapshotMetrics;
}

/**
 * Metrics Exporter Interface
 */
export interface IMetricsExporter {
  /** Get current system metrics */
  getMetrics(): SystemMetrics;
  
  /** Export metrics in Prometheus format */
  exportPrometheus(): string;
  
  /** Export metrics as JSON */
  exportJSON(): string;
  
  /** Register custom metric */
  registerMetric(name: string, type: 'counter' | 'gauge' | 'histogram', help: string): void;
  
  /** Increment counter */
  incrementCounter(name: string, value?: number, labels?: Record<string, string>): void;
  
  /** Set gauge value */
  setGauge(name: string, value: number, labels?: Record<string, string>): void;
  
  /** Observe histogram value */
  observeHistogram(name: string, value: number, labels?: Record<string, string>): void;
}

/**
 * Replay Engine Interface
 */
export interface IReplayEngine {
  /** Replay all events from the beginning */
  replayAll(handler: (event: WALEvent) => Promise<void>): Promise<ReplayMetrics>;
  
  /** Replay from a specific sequence */
  replayFrom(fromSequence: bigint, handler: (event: WALEvent) => Promise<void>): Promise<ReplayMetrics>;
  
  /** Replay from snapshot + WAL */
  replayFromSnapshot(snapshotId: string, handler: (event: WALEvent) => Promise<void>): Promise<ReplayMetrics>;
  
  /** Get current replay lag */
  getReplayLag(): bigint;
  
  /** Get replay metrics */
  getMetrics(): ReplayMetrics;
}

/**
 * Benchmark Runner Interface
 */
export interface IBenchmarkRunner {
  /** Run a specific benchmark */
  runBenchmark(config: BenchmarkConfig): Promise<BenchmarkResult>;
  
  /** Run all benchmarks */
  runAllBenchmarks(): Promise<BenchmarkResult[]>;
  
  /** Get available benchmark configurations */
  getAvailableBenchmarks(): BenchmarkConfig[];
}

/**
 * Verification Engine Interface
 */
export interface IVerificationEngine {
  /** Verify WAL integrity */
  verifyWALIntegrity(): Promise<VerificationResult>;
  
  /** Verify snapshot consistency with WAL */
  verifySnapshotConsistency(snapshotId: string): Promise<VerificationResult>;
  
  /** Verify replay determinism */
  verifyReplayDeterminism(): Promise<VerificationResult>;
  
  /** Run full verification suite */
  runFullVerification(): Promise<VerificationResult>;
}
