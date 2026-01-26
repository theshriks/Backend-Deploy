/**
 * ShrikDB Phase 6.2 - Truth Bridge
 * 
 * Production-grade bridge connecting Velocity Engine (fast) to ShrikDB WAL (truth).
 * 
 * @example
 * ```typescript
 * import { TruthBridge, VelocityEvent } from 'shrikdb-phase6-truth-bridge';
 * 
 * const bridge = new TruthBridge(wal, { dataDir: './data/bridge' });
 * await bridge.initialize();
 * 
 * const event: VelocityEvent = {
 *   velocitySeq: 1n,
 *   streamId: 'orders',
 *   tenantId: 'tenant-1',
 *   eventType: 'order.created',
 *   payload: { orderId: '123' },
 *   irreversibilityMarker: true,
 *   timestamp: Date.now() * 1000
 * };
 * 
 * const receipt = await bridge.accept(event);
 * console.log(`Delivered to WAL at sequence ${receipt.walSequence}`);
 * ```
 */

// Contracts
export * from './contracts/types';

// Bridge Components
export { TruthBridge } from './bridge/truth-bridge';
export { IrreversibilityGate } from './bridge/irreversibility-gate';
export { IdempotencyRegistry } from './bridge/idempotency-registry';
export { SafeBuffer } from './bridge/safe-buffer';
export { BackpressureController } from './bridge/backpressure-controller';
export { BatchForwarder, IWALTarget } from './bridge/batch-forwarder';

// Utils
export { crc32, verifyCrc32 } from './utils/crc32';

// Verification
export { runVerificationSuite } from './verification/run-verification';
