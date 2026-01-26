/**
 * Truth Bridge - Main Entry Point
 * 
 * Production-grade bridge connecting Velocity Engine (fast) to ShrikDB WAL (truth).
 * 
 * GUARANTEES:
 * - Only irreversible events cross the boundary
 * - Exactly-once delivery (no duplicates)
 * - Per-stream ordering preserved
 * - Crash recovery without data loss or duplicates
 * - Backpressure when WAL is slow
 * 
 * ARCHITECTURE:
 * VelocityEvent → IrreversibilityGate → IdempotencyRegistry → SafeBuffer → BatchForwarder → WAL
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    VelocityEvent,
    DeliveryReceipt,
    BridgeConfig,
    BridgeMetrics,
    BridgeState,
    RecoveryReport,
    ITruthBridge,
    BridgeError,
    BridgeErrorCode,
    DEFAULT_BRIDGE_CONFIG
} from '../contracts/types';
import { IrreversibilityGate } from './irreversibility-gate';
import { IdempotencyRegistry } from './idempotency-registry';
import { SafeBuffer } from './safe-buffer';
import { BackpressureController } from './backpressure-controller';
import { BatchForwarder, IWALTarget } from './batch-forwarder';

export class TruthBridge implements ITruthBridge {
    private readonly config: BridgeConfig;
    private readonly wal: IWALTarget;

    // Components
    private gate: IrreversibilityGate;
    private registry: IdempotencyRegistry;
    private buffer: SafeBuffer;
    private backpressure: BackpressureController;
    private forwarder: BatchForwarder;

    // State
    private initialized = false;
    private startTime = Date.now();

    // Metrics
    private totalReceived = 0n;
    private totalDelivered = 0n;
    private totalRejected = 0n;
    private totalDuplicates = 0n;

    constructor(wal: IWALTarget, config: Partial<BridgeConfig> = {}) {
        this.config = { ...DEFAULT_BRIDGE_CONFIG, ...config };
        this.wal = wal;

        // Initialize components
        this.gate = new IrreversibilityGate();
        this.registry = new IdempotencyRegistry(this.config.dataDir);
        this.buffer = new SafeBuffer(this.config.dataDir);
        this.backpressure = new BackpressureController({
            highWatermark: this.config.backpressureHighWatermark,
            lowWatermark: this.config.backpressureLowWatermark
        });
        this.forwarder = new BatchForwarder(wal, {
            maxBatchSize: this.config.maxBatchSize,
            maxBatchDelayMs: this.config.maxBatchDelayMs,
            retryMaxAttempts: this.config.retryMaxAttempts,
            retryBaseDelayMs: this.config.retryBaseDelayMs
        });
    }

    /**
     * Initialize the bridge.
     * Returns recovery report if recovery was needed.
     */
    async initialize(): Promise<RecoveryReport | null> {
        if (this.initialized) {
            return null;
        }

        // Ensure data directory exists
        if (!fs.existsSync(this.config.dataDir)) {
            fs.mkdirSync(this.config.dataDir, { recursive: true });
        }

        // Initialize components
        await this.registry.initialize();
        await this.buffer.initialize();

        // Check if recovery is needed
        const pendingCount = this.buffer.size();
        if (pendingCount > 0) {
            return await this.recover();
        }

        this.initialized = true;
        this.startTime = Date.now();
        return null;
    }

    /**
     * Accept event from Velocity Engine.
     * Returns delivery receipt on success.
     */
    async accept(event: VelocityEvent): Promise<DeliveryReceipt> {
        if (!this.initialized) {
            throw new BridgeError(
                'Bridge not initialized',
                BridgeErrorCode.NOT_INITIALIZED,
                false
            );
        }

        this.totalReceived++;

        // Step 1: Check idempotency FIRST (before gate)
        // This ensures duplicates return existing receipt even after gate update
        const key = { velocitySeq: event.velocitySeq, streamId: event.streamId };
        if (this.registry.isDelivered(key)) {
            this.totalDuplicates++;
            const existing = this.registry.getReceipt(key)!;
            return existing;
        }

        // Step 2: Check irreversibility boundary
        if (!this.gate.canCross(event)) {
            this.totalRejected++;

            if (!event.irreversibilityMarker) {
                throw new BridgeError(
                    `Event ${event.velocitySeq} is not marked as irreversible`,
                    BridgeErrorCode.TRANSIENT_EVENT,
                    false
                );
            }

            throw new BridgeError(
                `Event ${event.velocitySeq} cannot cross boundary (sequence issue)`,
                BridgeErrorCode.SEQUENCE_REORDER,
                false
            );
        }

        // Step 3: Check backpressure
        if (!this.backpressure.canAccept()) {
            await this.backpressure.waitForCapacity();
        }

        // Step 4: Buffer event (crash safety)
        await this.buffer.push(event);
        this.backpressure.onBufferChange(this.buffer.size());

        // Step 5: Forward to WAL
        try {
            const receipt = await this.forwarder.forward(event);

            // Step 6: Mark as delivered
            await this.registry.markDelivered(receipt);
            this.gate.markCrossed(event);

            // Step 7: Acknowledge in buffer
            await this.buffer.acknowledge(event.velocitySeq, event.streamId);
            this.backpressure.onBufferChange(this.buffer.size());

            this.totalDelivered++;
            return receipt;
        } catch (error) {
            // Event stays in buffer for retry
            throw error;
        }
    }

    /**
     * Accept batch of events.
     */
    async acceptBatch(events: VelocityEvent[]): Promise<DeliveryReceipt[]> {
        const receipts: DeliveryReceipt[] = [];

        for (const event of events) {
            try {
                const receipt = await this.accept(event);
                receipts.push(receipt);
            } catch (error) {
                // For batch, we continue on recoverable errors
                if (error instanceof BridgeError && error.recoverable) {
                    continue;
                }
                throw error;
            }
        }

        return receipts;
    }

    /**
     * Force flush all pending events.
     */
    async flush(): Promise<void> {
        await this.forwarder.flush();
        await this.registry.flush();
    }

    /**
     * Graceful shutdown.
     */
    async shutdown(): Promise<void> {
        // Stop accepting new events
        this.initialized = false;

        // Flush pending
        await this.flush();

        // Close components
        await this.forwarder.stop();
        await this.registry.close();
        await this.buffer.close();

        // Release backpressure waiters
        this.backpressure.forceRelease();
    }

    /**
     * Get current metrics.
     */
    getMetrics(): BridgeMetrics {
        const forwarderMetrics = this.forwarder.getMetrics();
        const backpressureMetrics = this.backpressure.getMetrics();

        return {
            totalReceived: this.totalReceived,
            totalDelivered: this.totalDelivered,
            totalRejected: this.totalRejected,
            totalDuplicates: this.totalDuplicates,
            bufferSize: this.buffer.size(),
            latencyP50Micros: forwarderMetrics.latencyP50Micros,
            latencyP99Micros: forwarderMetrics.latencyP99Micros,
            retryCount: forwarderMetrics.totalRetries,
            backpressureTriggerCount: backpressureMetrics.triggerCount,
            uptimeMs: Date.now() - this.startTime
        };
    }

    /**
     * Get current state.
     */
    getState(): BridgeState {
        const streamStates = this.gate.getAllStreamStates();
        const lastProcessedSeq = new Map<string, bigint>();
        for (const [streamId, state] of streamStates) {
            lastProcessedSeq.set(streamId, state.lastCrossed);
        }

        return {
            initialized: this.initialized,
            lastProcessedSeq,
            lastWalSequence: this.wal.getHeadSequence(),
            bufferSize: this.buffer.size(),
            backpressureActive: !this.backpressure.canAccept()
        };
    }

    /**
     * Recover from crash.
     */
    private async recover(): Promise<RecoveryReport> {
        const startTime = Date.now();
        const errors: string[] = [];
        let pendingEvents = 0;
        let skippedDuplicates = 0;
        let redelivered = 0;

        console.log('[TruthBridge] Starting recovery...');

        // Process pending events from buffer
        for await (const event of this.buffer.getPending()) {
            pendingEvents++;

            const key = { velocitySeq: event.velocitySeq, streamId: event.streamId };

            // Check if already delivered
            if (this.registry.isDelivered(key)) {
                skippedDuplicates++;
                // Acknowledge in buffer
                await this.buffer.acknowledge(event.velocitySeq, event.streamId);
                continue;
            }

            // Redeliver
            try {
                const receipt = await this.forwarder.forward(event);
                await this.registry.markDelivered(receipt);
                await this.buffer.acknowledge(event.velocitySeq, event.streamId);
                redelivered++;

                // Update gate state
                this.gate.markCrossed(event);
            } catch (error) {
                errors.push(`Failed to redeliver ${event.streamId}:${event.velocitySeq}: ${(error as Error).message}`);
            }
        }

        // Update backpressure
        this.backpressure.onBufferChange(this.buffer.size());

        this.initialized = true;
        this.startTime = Date.now();

        const report: RecoveryReport = {
            recoveryNeeded: true,
            pendingEvents,
            skippedDuplicates,
            redelivered,
            recoveryDurationMs: Date.now() - startTime,
            errors
        };

        console.log(`[TruthBridge] Recovery complete: ${pendingEvents} pending, ${skippedDuplicates} skipped, ${redelivered} redelivered`);

        return report;
    }
}
