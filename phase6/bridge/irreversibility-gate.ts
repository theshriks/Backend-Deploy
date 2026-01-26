/**
 * Irreversibility Gate
 * 
 * Determines when fast events can cross the boundary to become truth.
 * 
 * INVARIANTS:
 * - Only events with irreversibilityMarker=true can cross
 * - Sequences must be monotonically increasing per stream
 * - No gaps allowed in sequence (after crossing)
 * - Once crossed, an event cannot be un-crossed
 */

import {
    VelocityEvent,
    IIrreversibilityGate,
    BridgeError,
    BridgeErrorCode
} from '../contracts/types';

interface StreamState {
    /** Last irreversible sequence that crossed */
    lastCrossed: bigint;
    /** Last seen sequence (for gap detection) */
    lastSeen: bigint;
}

export class IrreversibilityGate implements IIrreversibilityGate {
    private streamStates: Map<string, StreamState> = new Map();
    private readonly strictOrdering: boolean;

    constructor(options: { strictOrdering?: boolean } = {}) {
        this.strictOrdering = options.strictOrdering ?? true;
    }

    /**
     * Check if an event can cross the irreversibility boundary.
     * 
     * An event can cross if:
     * 1. It has irreversibilityMarker = true
     * 2. Its sequence is greater than the last crossed sequence for its stream
     * 3. (If strict) Its sequence is exactly lastCrossed + 1 (no gaps)
     */
    canCross(event: VelocityEvent): boolean {
        // Rule 1: Must be marked as irreversible
        if (!event.irreversibilityMarker) {
            return false;
        }

        const state = this.getOrCreateState(event.streamId);

        // Rule 2: Must be after last crossed
        if (event.velocitySeq <= state.lastCrossed) {
            return false;
        }

        // Rule 3: If strict ordering, must be exactly next in sequence
        if (this.strictOrdering && state.lastCrossed > 0n) {
            if (event.velocitySeq !== state.lastCrossed + 1n) {
                return false;
            }
        }

        return true;
    }

    /**
     * Validate that an event's sequence is in order.
     * Throws if validation fails.
     */
    validateSequence(event: VelocityEvent): boolean {
        const state = this.getOrCreateState(event.streamId);

        // Check for reordering (sequence less than or equal to last crossed)
        if (event.velocitySeq <= state.lastCrossed) {
            throw new BridgeError(
                `Sequence reorder detected: event ${event.velocitySeq} <= last crossed ${state.lastCrossed} for stream ${event.streamId}`,
                BridgeErrorCode.SEQUENCE_REORDER,
                false
            );
        }

        // Check for gaps in strict mode
        if (this.strictOrdering && state.lastCrossed > 0n) {
            const expectedSeq = state.lastCrossed + 1n;
            if (event.velocitySeq !== expectedSeq) {
                throw new BridgeError(
                    `Sequence gap detected: expected ${expectedSeq}, got ${event.velocitySeq} for stream ${event.streamId}`,
                    BridgeErrorCode.SEQUENCE_GAP,
                    true // Recoverable - might receive missing event later
                );
            }
        }

        // Update last seen
        if (event.velocitySeq > state.lastSeen) {
            state.lastSeen = event.velocitySeq;
        }

        return true;
    }

    /**
     * Mark an event as having crossed the boundary.
     * Called after successful delivery to WAL.
     */
    markCrossed(event: VelocityEvent): void {
        const state = this.getOrCreateState(event.streamId);

        if (event.velocitySeq <= state.lastCrossed) {
            // Already crossed - this is a duplicate attempt
            throw new BridgeError(
                `Event ${event.velocitySeq} already crossed for stream ${event.streamId}`,
                BridgeErrorCode.DUPLICATE_EVENT,
                false
            );
        }

        state.lastCrossed = event.velocitySeq;
    }

    /**
     * Get the last irreversible sequence that crossed for a stream.
     */
    getLastIrreversible(streamId: string): bigint {
        const state = this.streamStates.get(streamId);
        return state?.lastCrossed ?? 0n;
    }

    /**
     * Get state for all streams.
     */
    getAllStreamStates(): Map<string, { lastCrossed: bigint; lastSeen: bigint }> {
        const result = new Map<string, { lastCrossed: bigint; lastSeen: bigint }>();
        for (const [streamId, state] of this.streamStates) {
            result.set(streamId, {
                lastCrossed: state.lastCrossed,
                lastSeen: state.lastSeen
            });
        }
        return result;
    }

    /**
     * Restore state from checkpoint (for recovery).
     */
    restoreState(states: Map<string, bigint>): void {
        for (const [streamId, lastCrossed] of states) {
            this.streamStates.set(streamId, {
                lastCrossed,
                lastSeen: lastCrossed
            });
        }
    }

    /**
     * Reset state for a stream (for testing).
     */
    resetStream(streamId: string): void {
        this.streamStates.delete(streamId);
    }

    /**
     * Reset all state (for testing).
     */
    reset(): void {
        this.streamStates.clear();
    }

    private getOrCreateState(streamId: string): StreamState {
        let state = this.streamStates.get(streamId);
        if (!state) {
            state = {
                lastCrossed: 0n,
                lastSeen: 0n
            };
            this.streamStates.set(streamId, state);
        }
        return state;
    }
}
