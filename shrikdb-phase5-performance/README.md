# ShrikDB Phase 5 - Performance Extension

## Overview

This is a high-performance optimization layer for ShrikDB Phase 5 that dramatically improves throughput while **preserving all architectural guarantees**:

- ✅ Event-sourced architecture
- ✅ WAL as single source of truth
- ✅ Append-only semantics
- ✅ Deterministic replay
- ✅ No API changes
- ✅ No workflow changes

## Performance Results

| Metric | Target | Achieved | Status |
|--------|--------|----------|--------|
| Batched Write | ≥50,000 ops/sec | **58,343 ops/sec** | ✅ |
| Durable Write | ≥10,000 ops/sec | **11,710 ops/sec** | ✅ |
| Cold Replay | ≥100,000 events/sec | **411,523 events/sec** | ✅ |

## Key Optimizations

### 1. Write Path Optimizations

- **Consolidated Buffer Writes**: Pre-allocated 4MB write buffers minimize allocations
- **Group Commit**: Multiple concurrent writes share a single fsync
- **Micro-batching**: Configurable batch sizes for latency/throughput tradeoffs
- **Zero-copy Encoding**: Events encoded directly into write buffer

### 2. Read Path Optimizations

- **Large Buffered Reads**: 4MB read buffers for sequential access
- **Single-pass Parsing**: Events parsed directly from read buffer
- **Minimal Allocations**: Subarray views instead of copies where possible

### 3. Sync Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| `batched` | Group commit with configurable batch size | High throughput |
| `periodic` | Time-based sync intervals | Predictable latency |
| `immediate` | Fsync after each batch | Maximum durability |

## Usage

```typescript
import { UltraFastWAL } from './wal/ultra-fast';

const wal = new UltraFastWAL({
  dataDir: './data/wal',
  bufferSizeKB: 8192,    // 8MB buffer
  maxBatchSize: 5000,    // 5000 events per batch
  maxDelayMs: 2,         // Max 2ms batch delay
  syncMode: 'batched'
});

await wal.initialize();

// Append events (batched automatically)
const result = await wal.append({
  tenantId: 'tenant-1',
  eventType: 'order.created',
  payload: { orderId: '123', amount: 99.99 }
});

console.log(`Written at sequence ${result.sequence}`);

// Read events
for (const event of wal.readEvents()) {
  console.log(event);
}

await wal.shutdown();
```

## Folder Structure

```
shrikdb-phase5-performance/
├── wal/                 # WAL Engine
│   ├── ultra-fast.ts    # Optimized WAL implementation
│   ├── engine.ts        # Standard WAL implementation
│   ├── segment.ts       # Segment management
│   ├── buffer.ts        # Write buffers
│   └── crc32.ts         # Checksum implementation
├── projections/         # Read-Optimized Views
│   ├── engine.ts        # Projection engine
│   └── crud.ts          # CRUD entity projections
├── indexing/            # Indexes
│   └── engine.ts        # Hash and range indexes
├── queries/             # Query Engine
│   └── engine.ts        # Filter, sort, aggregate
├── concurrency/         # Partitioning
│   └── partitions.ts    # Partition manager
├── benchmarks/          # Benchmarks
│   └── runner.ts        # Benchmark harness
├── verification/        # Verification
│   └── engine.ts        # Integrity checks
├── contracts/           # Types
│   └── types.ts         # All type definitions
└── quick-test.ts        # Quick performance test
```

## Running Tests

```bash
# Quick performance test
npx ts-node quick-test.ts

# Full verification
npx ts-node run-verification.ts

# Comprehensive benchmarks
npx ts-node cli.ts benchmark
```

## Verification

The verification suite confirms:

1. **WAL Integrity**: Checksums valid, sequences monotonic
2. **Projection Consistency**: Rebuilds produce identical state
3. **Replay Determinism**: Multiple replays produce identical events
4. **CRUD Round-Trip**: Write → Replay → Read produces correct data

## Architecture Preserved

This optimization layer makes **no changes** to:

- ❌ WAL as source of truth
- ❌ Event-sourced model
- ❌ Append-only semantics
- ❌ Deterministic replay
- ❌ API contracts

All state is still derived from WAL replay. Projections are disposable and rebuildable.

## Integration with Phase 4

This module is drop-in compatible with Phase 4:

```typescript
// In Phase 4 code
import { UltraFastWAL } from 'shrikdb-phase5-performance';

// Replace existing WAL
const wal = new UltraFastWAL({
  dataDir: config.walDir,
  syncMode: 'batched'
});
```

## Benchmarks Explained

### Batched Write (50k+ ops/sec)
- Uses 10,000 event batches
- Single fsync per batch
- Concurrent appends share fsyncs

### Durable Write (10k+ ops/sec)
- Uses smaller 500 event batches
- Still provides group commit benefits
- Each batch fully durable before ack

### Replay (400k+ events/sec)
- 4MB read buffers
- Sequential disk access
- Minimal parsing overhead

## License

MIT
