# ShrikDB Phase 6.2 - Truth Bridge

## Overview

The Truth Bridge is a production-grade component that connects the **Velocity Engine** (fast in-memory events) to **ShrikDB's WAL** (truth layer). It ensures that only irreversible events become truth, with exactly-once delivery semantics and crash recovery guarantees.

```
Velocity Engine (Fast)
         │
    ┌────▼────┐
    │Irreversibility│  ← Only irreversible events pass
    │   Gate       │
    └────┬────┘
    ┌────▼────┐
    │Idempotency│   ← Exactly-once semantics
    │ Registry  │
    └────┬────┘
    ┌────▼────┐
    │  Safe   │     ← Crash-safe buffering
    │ Buffer  │
    └────┬────┘
    ┌────▼────┐
    │  Batch  │     ← Retry with backoff
    │Forwarder│
    └────┬────┘
         │
    ShrikDB WAL (Truth)
```

## Guarantees

| Guarantee | Description |
|-----------|-------------|
| **Irreversibility Boundary** | Only events marked as irreversible can cross to WAL |
| **Exactly-Once Delivery** | No duplicate events in WAL, even after crashes |
| **Per-Stream Ordering** | Events are ordered by velocity sequence within each stream |
| **Crash Recovery** | Pending events are recovered and re-delivered after crash |
| **Backpressure** | Flow control when WAL is slow or unavailable |

## Installation

```bash
cd g:\Projects\phase6
npm install
```

## Usage

### Quick Start

```typescript
import { TruthBridge, VelocityEvent } from './index';

// Create WAL instance (from Phase 5)
const wal = new UltraFastWAL({ dataDir: './data/wal' });
await wal.initialize();

// Create bridge
const bridge = new TruthBridge(wal, {
    dataDir: './data/bridge'
});

// Initialize (recovers if needed)
const recoveryReport = await bridge.initialize();
if (recoveryReport) {
    console.log(`Recovered ${recoveryReport.redelivered} events`);
}

// Accept events from Velocity Engine
const event: VelocityEvent = {
    velocitySeq: 1n,
    streamId: 'orders',
    tenantId: 'tenant-1',
    eventType: 'order.confirmed',
    payload: { orderId: '123', amount: 99.99 },
    irreversibilityMarker: true,
    timestamp: Date.now() * 1000
};

const receipt = await bridge.accept(event);
console.log(`Delivered at WAL sequence ${receipt.walSequence}`);

// Graceful shutdown
await bridge.shutdown();
```

### CLI

```bash
# Run verification suite
npx ts-node cli.ts verify

# Start bridge with demo
npx ts-node cli.ts start --demo

# Send test events
npx ts-node cli.ts send-test 1000

# Check status
npx ts-node cli.ts status

# Dump WAL contents
npx ts-node cli.ts dump-wal 50
```

## Configuration

```typescript
interface BridgeConfig {
    dataDir: string;              // Bridge data directory
    walDataDir: string;           // WAL data directory
    checkpointIntervalMs: number; // Checkpoint interval (default: 1000)
    maxBufferSize: number;        // Max buffer size (default: 100000)
    backpressureHighWatermark: number; // Trigger backpressure (default: 80000)
    backpressureLowWatermark: number;  // Release backpressure (default: 40000)
    retryMaxAttempts: number;     // Max retry attempts (default: 10)
    retryBaseDelayMs: number;     // Base retry delay (default: 100)
    maxBatchSize: number;         // Max batch size (default: 1000)
    maxBatchDelayMs: number;      // Max batch delay (default: 10)
}
```

## Components

| Component | File | Description |
|-----------|------|-------------|
| TruthBridge | `bridge/truth-bridge.ts` | Main orchestrator |
| IrreversibilityGate | `bridge/irreversibility-gate.ts` | Filters irreversible events |
| IdempotencyRegistry | `bridge/idempotency-registry.ts` | Prevents duplicates |
| SafeBuffer | `bridge/safe-buffer.ts` | Crash-safe pending buffer |
| BackpressureController | `bridge/backpressure-controller.ts` | Flow control |
| BatchForwarder | `bridge/batch-forwarder.ts` | Delivery with retry |

## Verification

Run the verification suite to prove correctness:

```bash
npx ts-node verification/run-verification.ts
```

Tests:
- ✓ No Duplicates (Normal)
- ✓ Duplicate Rejection
- ✓ Transient Event Rejection
- ✓ Per-Stream Ordering
- ✓ Crash Recovery
- ✓ Metrics Accuracy

## License

MIT
