/**
 * Backpressure Controller
 * 
 * Flow control mechanism that prevents buffer overflow when WAL is slow or unavailable.
 * Uses high/low watermarks to trigger and release backpressure.
 * 
 * BEHAVIOR:
 * - When buffer reaches high watermark: stop accepting new events
 * - When buffer drops to low watermark: resume accepting events
 * - Provides async wait mechanism for callers
 */

import { EventEmitter } from 'events';

export interface BackpressureConfig {
    /** Buffer size to trigger backpressure */
    highWatermark: number;
    /** Buffer size to release backpressure */
    lowWatermark: number;
}

export class BackpressureController extends EventEmitter {
    private readonly highWatermark: number;
    private readonly lowWatermark: number;
    private currentSize = 0;
    private backpressureActive = false;
    private waitingResolvers: Array<() => void> = [];

    // Metrics
    private triggerCount = 0;
    private releaseCount = 0;
    private totalWaitTimeMs = 0;

    constructor(config: BackpressureConfig) {
        super();
        this.highWatermark = config.highWatermark;
        this.lowWatermark = config.lowWatermark;

        if (this.lowWatermark >= this.highWatermark) {
            throw new Error('lowWatermark must be less than highWatermark');
        }
    }

    /**
     * Check if currently accepting new events.
     */
    canAccept(): boolean {
        return !this.backpressureActive;
    }

    /**
     * Update current buffer size and check watermarks.
     */
    onBufferChange(size: number): void {
        const previousSize = this.currentSize;
        this.currentSize = size;

        // Check if we need to trigger backpressure
        if (!this.backpressureActive && size >= this.highWatermark) {
            this.triggerBackpressure();
        }
        // Check if we can release backpressure
        else if (this.backpressureActive && size <= this.lowWatermark) {
            this.releaseBackpressure();
        }
    }

    /**
     * Wait until capacity is available.
     * Returns immediately if not under backpressure.
     */
    async waitForCapacity(): Promise<void> {
        if (!this.backpressureActive) {
            return;
        }

        const startTime = Date.now();

        return new Promise<void>((resolve) => {
            this.waitingResolvers.push(resolve);
        }).finally(() => {
            this.totalWaitTimeMs += Date.now() - startTime;
        });
    }

    /**
     * Get current state.
     */
    getState(): {
        backpressureActive: boolean;
        currentSize: number;
        highWatermark: number;
        lowWatermark: number;
        waitingCount: number;
    } {
        return {
            backpressureActive: this.backpressureActive,
            currentSize: this.currentSize,
            highWatermark: this.highWatermark,
            lowWatermark: this.lowWatermark,
            waitingCount: this.waitingResolvers.length
        };
    }

    /**
     * Get metrics.
     */
    getMetrics(): {
        triggerCount: number;
        releaseCount: number;
        totalWaitTimeMs: number;
    } {
        return {
            triggerCount: this.triggerCount,
            releaseCount: this.releaseCount,
            totalWaitTimeMs: this.totalWaitTimeMs
        };
    }

    /**
     * Force release backpressure (for shutdown).
     */
    forceRelease(): void {
        if (this.backpressureActive) {
            this.releaseBackpressure();
        }
    }

    private triggerBackpressure(): void {
        this.backpressureActive = true;
        this.triggerCount++;
        this.emit('backpressure', { active: true, size: this.currentSize });
    }

    private releaseBackpressure(): void {
        this.backpressureActive = false;
        this.releaseCount++;
        this.emit('backpressure', { active: false, size: this.currentSize });

        // Release all waiting callers
        const resolvers = this.waitingResolvers;
        this.waitingResolvers = [];
        for (const resolve of resolvers) {
            resolve();
        }
    }
}
