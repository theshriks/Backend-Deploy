# ShrikDB Phase 5 - Performance, Storage & Competitive Benchmarking

## Overview

ShrikDB Phase 5 provides hard performance, storage, and operational capabilities that push ShrikDB beyond hobby/prototype systems. This phase is designed to be **drop-in compatible** with Phase 4 without refactoring.

### Core Principles (Preserved)

- ✅ **WAL is the single source of truth**
- ✅ **Event-sourced, deterministic replay**
- ✅ **No mock data**
- ✅ **No simulated benchmarks**
- ✅ **No bypassing AppendEvent**
- ✅ **Production-only code**

## Architecture

```
shrikdb-phase5/
├── contracts/          # Type definitions & interfaces
│   ├── types.ts        # All public types
│   └── index.ts        # Export barrel
├── wal/                # Write-Ahead Log Engine
│   ├── crc32.ts        # CRC32 checksums
│   ├── segment.ts      # Segment management
│   ├── engine.ts       # WAL engine
│   └── index.ts        # Export barrel
├── snapshot/           # Snapshot Engine
│   ├── engine.ts       # Snapshot creation/restore
│   └── index.ts        # Export barrel
├── benchmark/          # Benchmark Harness
│   ├── runner.ts       # Benchmark runner
│   └── index.ts        # Export barrel
├── metrics/            # Metrics Export
│   ├── exporter.ts     # Prometheus/JSON export
│   └── index.ts        # Export barrel
├── verification/       # Integrity Verification
│   ├── engine.ts       # Verification engine
│   ├── verify-all.ts   # Full verification script
│   └── index.ts        # Export barrel
├── cli/                # Command Line Tools
│   └── shrikdb.ts      # CLI entry point
├── test/               # Test Suite
│   └── run-tests.ts    # Real data tests
└── index.ts            # Main entry point
```

## Features

### 1. Storage Engine Enhancements

#### Segment-Based WAL Layout
- Fixed-size segments (default 64MB)
- Automatic segment rotation
- Segment checksum verification
- Binary format with magic number validation

#### Snapshotting
- Snapshots derived ONLY from WAL replay
- No direct state writes
- Snapshot + WAL replay produces identical state
- Snapshot verification against WAL

#### Read-Optimized Projections
- Built from WAL replay
- Can be deleted and rebuilt
- Tenant-level state tracking

### 2. High-Throughput Write Path

- Batch WAL appends (configurable batch size)
- Lock minimization (single-writer discipline)
- Backpressure when:
  - Disk is slow
  - Queue depth exceeds threshold
  - Memory thresholds crossed
- Deterministic ordering preserved

### 3. Real Benchmarks

Available benchmarks:
- `single-tenant-sequential-writes`
- `single-tenant-burst-writes`
- `multi-tenant-writes`
- `large-payload-writes`
- `cold-start-replay`
- `snapshot-create`
- `snapshot-restore`

All benchmarks:
- Run against real data
- Output machine-verifiable results
- Fail if invariants break
- Are reproducible

### 4. Operational Tooling

#### CLI Commands

```bash
# WAL Operations
npm run cli -- wal inspect --data-dir ./data/wal
npm run cli -- wal verify --data-dir ./data/wal
npm run cli -- wal stats --data-dir ./data/wal

# Snapshot Operations
npm run cli -- snapshot create --data-dir ./data
npm run cli -- snapshot list --data-dir ./data
npm run cli -- snapshot restore <snapshotId> --data-dir ./data

# Benchmarks
npm run cli -- benchmark run
npm run cli -- benchmark run --name single-tenant-sequential-writes
npm run cli -- benchmark list

# Metrics
npm run cli -- metrics --format json
npm run cli -- metrics --format prometheus

# Verification
npm run cli -- verify --data-dir ./data
npm run cli -- verify --data-dir ./data --delete-projections
```

### 5. Integration Contract

All interfaces are defined in `contracts/types.ts`:

```typescript
// WAL Engine Interface
interface IWALEngine {
  initialize(): Promise<void>;
  appendEvent(tenantId: string, eventType: string, payload: Record<string, unknown>): Promise<WALAppendResult>;
  appendEvents(events: Array<{...}>): Promise<WALAppendResult[]>;
  readEvents(options: WALReadOptions): AsyncGenerator<WALEvent>;
  getHeadSequence(): bigint;
  getMetrics(): WALMetrics;
  rotateSegment(): Promise<void>;
  shutdown(): Promise<void>;
}

// Snapshot Engine Interface
interface ISnapshotEngine {
  createSnapshot(): Promise<SnapshotMetadata>;
  restoreFromSnapshot(snapshotId: string): Promise<SnapshotState>;
  listSnapshots(): Promise<SnapshotMetadata[]>;
  verifySnapshot(snapshotId: string): Promise<boolean>;
  // ...
}

// Metrics Exporter Interface
interface IMetricsExporter {
  getMetrics(): SystemMetrics;
  exportPrometheus(): string;
  exportJSON(): string;
  // ...
}
```

## Quick Start

### Installation

```bash
cd shrikdb-phase5
npm install
```

### Run Tests

```bash
npm test
```

### Run Benchmarks

```bash
npm run benchmark:run
```

### Full Verification

```bash
npm run verify:full
```

## Usage Examples

### Basic WAL Operations

```typescript
import { WALEngine } from './wal';

const wal = new WALEngine({
  dataDir: './data/wal',
  maxSegmentSizeBytes: 64 * 1024 * 1024,
  syncMode: 'batch',
  batchSize: 100
});

await wal.initialize();

// Append events
const result = await wal.appendEvent('tenant-1', 'user.created', {
  userId: '123',
  name: 'John Doe'
});

console.log(`Event written at sequence ${result.sequence}`);

// Read events
for await (const event of wal.readEvents({ tenantId: 'tenant-1' })) {
  console.log(event);
}

await wal.shutdown();
```

### Creating Snapshots

```typescript
import { WALEngine } from './wal';
import { SnapshotEngine } from './snapshot';

const wal = new WALEngine({ dataDir: './data/wal' });
await wal.initialize();

const snapshot = new SnapshotEngine(wal, './data/snapshots');

// Create snapshot from WAL replay
const metadata = await snapshot.createSnapshot();
console.log(`Snapshot created: ${metadata.snapshotId}`);

// Restore from snapshot
const state = await snapshot.restoreFromSnapshot(metadata.snapshotId);
console.log(`Restored state at sequence ${state.lastSequence}`);
```

### Running Benchmarks

```typescript
import { BenchmarkRunner } from './benchmark';

const runner = new BenchmarkRunner('./data/benchmark');
const results = await runner.runAllBenchmarks();

for (const result of results) {
  console.log(`${result.name}: ${result.opsPerSecond.toFixed(2)} ops/s`);
}
```

## Verification

The full verification script (`npm run verify:full`) performs:

1. **Delete Projections** - Removes all derived state
2. **WAL Segment Integrity** - Verifies checksums on all segments
3. **Sequence Monotonicity** - Ensures event ordering
4. **Snapshot Creation** - Creates snapshot from WAL replay
5. **Snapshot Consistency** - Verifies snapshot matches WAL
6. **Replay Determinism** - Two replays produce identical results
7. **WAL-Only Rebuild** - State can be rebuilt from WAL alone

## Metrics

### Available Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `shrikdb_wal_total_events` | Counter | Total events written |
| `shrikdb_wal_bytes_written` | Counter | Total bytes written |
| `shrikdb_wal_current_segment` | Gauge | Current segment ID |
| `shrikdb_wal_sealed_segments` | Gauge | Number of sealed segments |
| `shrikdb_wal_write_latency_p50` | Gauge | Write latency P50 (µs) |
| `shrikdb_wal_write_latency_p95` | Gauge | Write latency P95 (µs) |
| `shrikdb_wal_write_latency_p99` | Gauge | Write latency P99 (µs) |
| `shrikdb_wal_events_per_second` | Gauge | Events/sec |
| `shrikdb_wal_batch_queue_depth` | Gauge | Pending batch queue depth |
| `shrikdb_wal_backpressure` | Gauge | Backpressure active (0/1) |
| `shrikdb_replay_events_total` | Counter | Events replayed |
| `shrikdb_replay_lag_events` | Gauge | Replay lag |
| `shrikdb_snapshot_total` | Counter | Snapshots created |
| `shrikdb_snapshot_size_bytes` | Gauge | Total snapshot size |

## Phase 4 Integration

This phase is designed for clean integration with Phase 4:

1. **No runtime dependencies** - Phase 5 runs independently
2. **Clean interfaces** - All contracts in `contracts/types.ts`
3. **No assumptions** - No frontend/backend assumptions
4. **Drop-in compatible** - Import and use directly

### Integration Example

```typescript
// In Phase 4 code
import { WALEngine, SnapshotEngine, MetricsExporter } from 'shrikdb-phase5';

// Initialize engines
const wal = new WALEngine({ dataDir: config.walDir });
await wal.initialize();

const snapshots = new SnapshotEngine(wal, config.snapshotDir);
const metrics = new MetricsExporter();
metrics.setWALEngine(wal);
metrics.setSnapshotEngine(snapshots);

// Use in your application
app.post('/events', async (req, res) => {
  const result = await wal.appendEvent(
    req.body.tenantId,
    req.body.eventType,
    req.body.payload
  );
  res.json({ sequence: result.sequence.toString() });
});

app.get('/metrics', (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.send(metrics.exportPrometheus());
});
```

## Constraints

- ❌ No mock data
- ❌ No simulated benchmarks
- ❌ No fake metrics
- ❌ No replacing WAL with external DB
- ❌ No breaking replay determinism
- ❌ No frontend code
- ❌ No B-Tree/B+Tree primary store (yet)

## License

MIT
