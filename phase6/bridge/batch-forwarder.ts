/**
 * Batch Forwarder
 * 
 * Handles async batch delivery of events to WAL.
 * Implements retry with exponential backoff.
 * 
 * GUARANTEES:
 * - Events are delivered in order within a stream
 * - Retries use exponential backoff
 * - Failed deliveries are reported with full context
 */

import {
    VelocityEvent,
    DeliveryReceipt,
    BridgeError,
    BridgeErrorCode
} from '../contracts/types';
import { crc32 } from '../utils/crc32';

// Interface for WAL (to avoid circular dependency)
export interface IWALTarget {
    append(input: {
        tenantId: string;
        eventType: string;
        payload: Record<string, unknown>;
    }): Promise<{ sequence: bigint; latencyMicros: number }>;

    getHeadSequence(): bigint;
}

export interface ForwarderConfig {
    maxBatchSize: number;
    maxBatchDelayMs: number;
    retryMaxAttempts: number;
    retryBaseDelayMs: number;
}

interface PendingBatch {
    events: VelocityEvent[];
    resolvers: Array<{
        resolve: (receipt: DeliveryReceipt) => void;
        reject: (error: Error) => void;
    }>;
    createdAt: number;
}

export class BatchForwarder {
    private readonly wal: IWALTarget;
    private readonly config: ForwarderConfig;

    private pendingBatch: PendingBatch | null = null;
    private batchTimer: NodeJS.Timeout | null = null;
    private processing = false;

    // Metrics
    private totalDelivered = 0n;
    private totalRetries = 0;
    private deliveryLatencies: number[] = [];

    constructor(wal: IWALTarget, config: ForwarderConfig) {
        this.wal = wal;
        this.config = config;
    }

    /**
     * Queue event for delivery.
     * Returns when event is successfully written to WAL.
     */
    async forward(event: VelocityEvent): Promise<DeliveryReceipt> {
        return new Promise<DeliveryReceipt>((resolve, reject) => {
            this.addToBatch(event, resolve, reject);
        });
    }

    /**
     * Forward batch of events.
     */
    async forwardBatch(events: VelocityEvent[]): Promise<DeliveryReceipt[]> {
        return Promise.all(events.map(e => this.forward(e)));
    }

    /**
     * Force flush pending batch.
     */
    async flush(): Promise<void> {
        if (this.batchTimer) {
            clearTimeout(this.batchTimer);
            this.batchTimer = null;
        }

        if (this.pendingBatch) {
            await this.processBatch();
        }
    }

    /**
     * Stop the forwarder.
     */
    async stop(): Promise<void> {
        await this.flush();
    }

    /**
     * Get metrics.
     */
    getMetrics(): {
        totalDelivered: bigint;
        totalRetries: number;
        latencyP50Micros: number;
        latencyP99Micros: number;
    } {
        const sorted = [...this.deliveryLatencies].sort((a, b) => a - b);
        return {
            totalDelivered: this.totalDelivered,
            totalRetries: this.totalRetries,
            latencyP50Micros: sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.5)]! : 0,
            latencyP99Micros: sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.99)]! : 0
        };
    }

    private addToBatch(
        event: VelocityEvent,
        resolve: (receipt: DeliveryReceipt) => void,
        reject: (error: Error) => void
    ): void {
        if (!this.pendingBatch) {
            this.pendingBatch = {
                events: [],
                resolvers: [],
                createdAt: Date.now()
            };

            // Start batch timer
            this.batchTimer = setTimeout(() => {
                this.processBatch().catch(console.error);
            }, this.config.maxBatchDelayMs);
        }

        this.pendingBatch.events.push(event);
        this.pendingBatch.resolvers.push({ resolve, reject });

        // Check if batch is full
        if (this.pendingBatch.events.length >= this.config.maxBatchSize) {
            if (this.batchTimer) {
                clearTimeout(this.batchTimer);
                this.batchTimer = null;
            }
            this.processBatch().catch(console.error);
        }
    }

    private async processBatch(): Promise<void> {
        if (this.processing || !this.pendingBatch) return;
        this.processing = true;

        const batch = this.pendingBatch;
        this.pendingBatch = null;

        try {
            // Process events one by one to maintain ordering
            for (let i = 0; i < batch.events.length; i++) {
                const event = batch.events[i]!;
                const { resolve, reject } = batch.resolvers[i]!;

                try {
                    const receipt = await this.deliverWithRetry(event);
                    resolve(receipt);
                } catch (error) {
                    reject(error as Error);
                }
            }
        } finally {
            this.processing = false;
        }
    }

    private async deliverWithRetry(event: VelocityEvent): Promise<DeliveryReceipt> {
        let lastError: Error | null = null;

        for (let attempt = 0; attempt < this.config.retryMaxAttempts; attempt++) {
            try {
                return await this.deliverSingle(event);
            } catch (error) {
                lastError = error as Error;
                this.totalRetries++;

                // Check if error is recoverable
                if (error instanceof BridgeError && !error.recoverable) {
                    throw error;
                }

                // Exponential backoff
                const delay = this.config.retryBaseDelayMs * Math.pow(2, attempt);
                await this.sleep(Math.min(delay, 30000)); // Cap at 30s
            }
        }

        throw new BridgeError(
            `Delivery failed after ${this.config.retryMaxAttempts} attempts: ${lastError?.message}`,
            BridgeErrorCode.DELIVERY_FAILED,
            false
        );
    }

    private async deliverSingle(event: VelocityEvent): Promise<DeliveryReceipt> {
        const startTime = performance.now();

        try {
            // Prepare payload for WAL
            // Include streamId and velocitySeq in payload for traceability
            const walPayload = {
                ...event.payload,
                __bridge: {
                    streamId: event.streamId,
                    velocitySeq: event.velocitySeq.toString(),
                    bridgedAt: Date.now()
                }
            };

            const result = await this.wal.append({
                tenantId: event.tenantId,
                eventType: event.eventType,
                payload: walPayload
            });

            const endTime = performance.now();
            const latencyMicros = Math.round((endTime - startTime) * 1000);

            // Track latency
            this.deliveryLatencies.push(latencyMicros);
            if (this.deliveryLatencies.length > 10000) {
                this.deliveryLatencies.shift();
            }

            this.totalDelivered++;

            // Calculate checksum for receipt
            const checksumData = Buffer.from(
                `${event.velocitySeq}:${event.streamId}:${result.sequence}:${event.eventType}`
            );
            const checksum = crc32(checksumData);

            return {
                velocitySeq: event.velocitySeq,
                walSequence: result.sequence,
                streamId: event.streamId,
                deliveredAt: Date.now() * 1000, // Microseconds
                checksum
            };
        } catch (error) {
            throw new BridgeError(
                `WAL append failed: ${(error as Error).message}`,
                BridgeErrorCode.WAL_UNAVAILABLE,
                true // Recoverable - can retry
            );
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
