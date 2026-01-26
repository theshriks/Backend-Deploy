/**
 * ShrikDB Phase 6.2 - Truth Bridge Contracts
 * 
 * Core type definitions for the bridge connecting
 * Velocity Engine (fast) to ShrikDB WAL (truth).
 * 
 * NON-NEGOTIABLE GUARANTEES:
 * - Only irreversible events cross the boundary
 * - Exactly-once delivery semantics
 * - Per-stream ordering preserved
 * - Crash recovery without duplicates
 */

// ============================================================================
// VELOCITY ENGINE TYPES (Input)
// ============================================================================

/**
 * Event from the Velocity Engine (fast layer).
 * These are buffered, transient events that may or may not become truth.
 */
export interface VelocityEvent {
    /** Monotonically increasing sequence from velocity layer */
    velocitySeq: bigint;

    /** Stream identifier for ordering guarantees */
    streamId: string;

    /** Tenant identifier */
    tenantId: string;

    /** Event type (e.g., 'order.created', 'payment.confirmed') */
    eventType: string;

    /** Event payload - arbitrary JSON-serializable data */
    payload: Record<string, unknown>;

    /** 
     * Irreversibility marker - when true, this event is ready to become truth.
     * Only events with this flag set to true can cross the bridge.
     */
    irreversibilityMarker: boolean;

    /** Timestamp in microseconds */
    timestamp: number;
}

// ============================================================================
// TRUTH EVENT TYPES (Output)
// ============================================================================

/**
 * Event written to WAL (truth layer).
 * Once written, this is the canonical source of truth.
 */
export interface TruthEvent {
    /** Sequence assigned by WAL */
    walSequence: bigint;

    /** Original sequence from velocity layer (for tracing) */
    velocitySeq: bigint;

    /** Stream identifier */
    streamId: string;

    /** Tenant identifier */
    tenantId: string;

    /** Event type */
    eventType: string;

    /** Serialized payload */
    payload: Buffer;

    /** Timestamp when delivered to WAL */
    deliveredAt: number;

    /** CRC32 checksum for integrity */
    checksum: number;
}

// ============================================================================
// IDEMPOTENCY TYPES
// ============================================================================

/**
 * Unique identifier for an event in the velocity layer.
 * Used for deduplication.
 */
export interface IdempotencyKey {
    velocitySeq: bigint;
    streamId: string;
}

/**
 * Receipt of successful delivery to WAL.
 * Stored in idempotency registry to prevent duplicates.
 */
export interface DeliveryReceipt {
    /** Original velocity sequence */
    velocitySeq: bigint;

    /** Assigned WAL sequence */
    walSequence: bigint;

    /** Stream identifier */
    streamId: string;

    /** Delivery timestamp in microseconds */
    deliveredAt: number;

    /** Checksum for integrity verification */
    checksum: number;
}

// ============================================================================
// BRIDGE CONFIGURATION
// ============================================================================

export interface BridgeConfig {
    /** Directory for bridge state (checkpoints, registry) */
    dataDir: string;

    /** WAL data directory */
    walDataDir: string;

    /** Checkpoint interval in milliseconds */
    checkpointIntervalMs: number;

    /** Maximum events in safe buffer before backpressure */
    maxBufferSize: number;

    /** Buffer size to trigger backpressure (stop accepting) */
    backpressureHighWatermark: number;

    /** Buffer size to release backpressure (resume accepting) */
    backpressureLowWatermark: number;

    /** Maximum retry attempts for delivery */
    retryMaxAttempts: number;

    /** Base delay for exponential backoff (ms) */
    retryBaseDelayMs: number;

    /** Maximum batch size for forwarding */
    maxBatchSize: number;

    /** Maximum delay before flushing partial batch (ms) */
    maxBatchDelayMs: number;
}

export const DEFAULT_BRIDGE_CONFIG: BridgeConfig = {
    dataDir: './data/bridge',
    walDataDir: './data/wal',
    checkpointIntervalMs: 1000,
    maxBufferSize: 100000,
    backpressureHighWatermark: 80000,
    backpressureLowWatermark: 40000,
    retryMaxAttempts: 10,
    retryBaseDelayMs: 100,
    maxBatchSize: 1000,
    maxBatchDelayMs: 10
};

// ============================================================================
// BRIDGE STATE & METRICS
// ============================================================================

export interface BridgeState {
    /** Is the bridge initialized and running? */
    initialized: boolean;

    /** Last velocity sequence processed per stream */
    lastProcessedSeq: Map<string, bigint>;

    /** Last WAL sequence written */
    lastWalSequence: bigint;

    /** Buffer size */
    bufferSize: number;

    /** Is backpressure active? */
    backpressureActive: boolean;
}

export interface BridgeMetrics {
    /** Total events received from velocity layer */
    totalReceived: bigint;

    /** Total events delivered to WAL */
    totalDelivered: bigint;

    /** Total events rejected (non-irreversible) */
    totalRejected: bigint;

    /** Total duplicates detected and skipped */
    totalDuplicates: bigint;

    /** Current buffer size */
    bufferSize: number;

    /** Delivery latency P50 (microseconds) */
    latencyP50Micros: number;

    /** Delivery latency P99 (microseconds) */
    latencyP99Micros: number;

    /** Number of retries performed */
    retryCount: number;

    /** Times backpressure was triggered */
    backpressureTriggerCount: number;

    /** Uptime in milliseconds */
    uptimeMs: number;
}

// ============================================================================
// RECOVERY TYPES
// ============================================================================

export interface Checkpoint {
    /** Timestamp of checkpoint */
    timestamp: number;

    /** Last processed velocity sequence per stream */
    lastProcessedSeq: Map<string, bigint>;

    /** Last WAL sequence at checkpoint time */
    lastWalSequence: bigint;

    /** Checksum of checkpoint data */
    checksum: number;
}

export interface RecoveryReport {
    /** Was recovery needed? */
    recoveryNeeded: boolean;

    /** Events found in buffer pending delivery */
    pendingEvents: number;

    /** Events skipped (already delivered) */
    skippedDuplicates: number;

    /** Events re-delivered during recovery */
    redelivered: number;

    /** Recovery duration in milliseconds */
    recoveryDurationMs: number;

    /** Any errors during recovery */
    errors: string[];
}

// ============================================================================
// ERROR TYPES
// ============================================================================

export class BridgeError extends Error {
    constructor(
        message: string,
        public readonly code: BridgeErrorCode,
        public readonly recoverable: boolean = false
    ) {
        super(message);
        this.name = 'BridgeError';
    }
}

export enum BridgeErrorCode {
    NOT_INITIALIZED = 'NOT_INITIALIZED',
    TRANSIENT_EVENT = 'TRANSIENT_EVENT',
    SEQUENCE_GAP = 'SEQUENCE_GAP',
    SEQUENCE_REORDER = 'SEQUENCE_REORDER',
    DUPLICATE_EVENT = 'DUPLICATE_EVENT',
    WAL_UNAVAILABLE = 'WAL_UNAVAILABLE',
    BUFFER_FULL = 'BUFFER_FULL',
    DELIVERY_FAILED = 'DELIVERY_FAILED',
    RECOVERY_FAILED = 'RECOVERY_FAILED',
    CHECKSUM_MISMATCH = 'CHECKSUM_MISMATCH'
}

// ============================================================================
// INTERFACE CONTRACTS
// ============================================================================

/**
 * Irreversibility Gate - determines if events can cross to truth layer.
 */
export interface IIrreversibilityGate {
    /** Check if event can cross the boundary */
    canCross(event: VelocityEvent): boolean;

    /** Get last irreversible sequence for stream */
    getLastIrreversible(streamId: string): bigint;

    /** Validate event sequence is in order */
    validateSequence(event: VelocityEvent): boolean;

    /** Mark event as crossed */
    markCrossed(event: VelocityEvent): void;
}

/**
 * Idempotency Registry - prevents duplicate delivery.
 */
export interface IIdempotencyRegistry {
    /** Check if event was already delivered */
    isDelivered(key: IdempotencyKey): boolean;

    /** Mark event as delivered */
    markDelivered(receipt: DeliveryReceipt): Promise<void>;

    /** Get receipt for delivered event */
    getReceipt(key: IdempotencyKey): DeliveryReceipt | null;

    /** Recover from storage */
    recover(): Promise<void>;

    /** Force sync to disk */
    flush(): Promise<void>;
}

/**
 * Safe Buffer - crash-safe pending event storage.
 */
export interface ISafeBuffer {
    /** Add event to buffer */
    push(event: VelocityEvent): Promise<void>;

    /** Mark event as delivered (remove from buffer) */
    acknowledge(velocitySeq: bigint, streamId: string): Promise<void>;

    /** Get all pending events */
    getPending(): AsyncGenerator<VelocityEvent>;

    /** Current buffer size */
    size(): number;

    /** Recover from storage */
    recover(): Promise<number>;
}

/**
 * Truth Bridge - main entry point.
 */
export interface ITruthBridge {
    /** Initialize bridge (recovers if needed) */
    initialize(): Promise<RecoveryReport | null>;

    /** Accept event from Velocity Engine */
    accept(event: VelocityEvent): Promise<DeliveryReceipt>;

    /** Accept batch of events */
    acceptBatch(events: VelocityEvent[]): Promise<DeliveryReceipt[]>;

    /** Force flush all pending */
    flush(): Promise<void>;

    /** Graceful shutdown */
    shutdown(): Promise<void>;

    /** Get current metrics */
    getMetrics(): BridgeMetrics;

    /** Get current state */
    getState(): BridgeState;
}
