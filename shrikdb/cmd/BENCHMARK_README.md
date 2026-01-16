# ShrikDB Content Store Benchmark Suite

This directory contains a comprehensive benchmark suite for comparing ShrikDB's content-addressable storage against established systems.

## Overview

The benchmark suite includes:

1. **ShrikDB Content Store** - Native content-addressable storage with streaming uploads
2. **MongoDB GridFS** - MongoDB's file storage system
3. **PostgreSQL Large Objects** - PostgreSQL's binary large object storage
4. **Filesystem Baseline** - Direct filesystem writes for baseline comparison
5. **Aggregator** - Combines results from all systems into a single report

## Prerequisites

### ShrikDB Benchmark
- Go 1.21 or later
- ShrikDB dependencies (see main go.mod)

### MongoDB Benchmark
- MongoDB server running (default: localhost:27017)
- Go MongoDB driver: `go get go.mongodb.org/mongo-driver/mongo`

### PostgreSQL Benchmark
- PostgreSQL server running (default: localhost:5432)
- PostgreSQL driver: `go get github.com/lib/pq`

### Filesystem Benchmark
- No external dependencies

## Building

Build all benchmarks:

```bash
# From shrikdb directory
go build -o bin/benchmark-content-store ./cmd/benchmark-content-store
go build -o bin/benchmark-mongodb ./cmd/benchmark-mongodb
go build -o bin/benchmark-postgresql ./cmd/benchmark-postgresql
go build -o bin/benchmark-filesystem ./cmd/benchmark-filesystem
go build -o bin/benchmark-aggregator ./cmd/benchmark-aggregator
```

## Running Benchmarks

### 1. ShrikDB Content Store

```bash
./bin/benchmark-content-store \
  -data-dir ./benchmark-data/shrikdb \
  -file-size 1048576 \
  -concurrency 10 \
  -duration 30s \
  -warmup 5s \
  -output results/benchmark-shrikdb.json
```

### 2. MongoDB GridFS

First, start MongoDB:
```bash
mongod --dbpath ./mongodb-data
```

Then run the benchmark:
```bash
./bin/benchmark-mongodb \
  -mongo-uri mongodb://localhost:27017 \
  -database benchmark \
  -file-size 1048576 \
  -concurrency 10 \
  -duration 30s \
  -warmup 5s \
  -output results/benchmark-mongodb.json
```

### 3. PostgreSQL Large Objects

First, start PostgreSQL and create the database:
```bash
createdb benchmark
```

Then run the benchmark:
```bash
./bin/benchmark-postgresql \
  -conn "postgres://postgres:postgres@localhost:5432/benchmark?sslmode=disable" \
  -file-size 1048576 \
  -concurrency 10 \
  -duration 30s \
  -warmup 5s \
  -output results/benchmark-postgresql.json
```

### 4. Filesystem Baseline

```bash
./bin/benchmark-filesystem \
  -data-dir ./benchmark-data/filesystem \
  -file-size 1048576 \
  -concurrency 10 \
  -duration 30s \
  -warmup 5s \
  -sync-mode always \
  -output results/benchmark-filesystem.json
```

### 5. Aggregate Results

After running all benchmarks:

```bash
./bin/benchmark-aggregator \
  -input-dir results \
  -output results/benchmark-aggregated-report.json \
  -report-id "comparison-2026-01-14"
```

## Benchmark Parameters

All benchmarks support these common parameters:

- `-file-size`: Size of each file in bytes (default: 1MB)
- `-concurrency`: Number of concurrent clients (default: 10)
- `-duration`: Benchmark duration (default: 30s)
- `-warmup`: Warmup duration before measurement (default: 5s)
- `-output`: Output file for results (JSON format)

## Output Format

Each benchmark produces a JSON file with the following structure:

```json
{
  "system": "shrikdb",
  "configuration": {
    "storage_backend": "filesystem",
    "sync_mode": "always",
    "chunk_size": 65536,
    "max_concurrent": 10
  },
  "throughput_mbps": 245.7,
  "latency_p50_ms": 12.3,
  "latency_p95_ms": 45.2,
  "latency_p99_ms": 89.1,
  "cpu_percent_avg": 34.5,
  "memory_mb_peak": 256,
  "error_rate": 0.0,
  "workload": {
    "file_count": 1000,
    "file_size_bytes": 1048576,
    "concurrent_clients": 10
  },
  "timestamp": "2026-01-14T10:30:00Z"
}
```

## Aggregated Report Format

The aggregator produces a combined report:

```json
{
  "report_id": "comparison-2026-01-14",
  "generated_at": "2026-01-14T10:30:00Z",
  "results": [
    { /* ShrikDB result */ },
    { /* MongoDB result */ },
    { /* PostgreSQL result */ },
    { /* Filesystem result */ }
  ],
  "summary": {
    "total_systems": 4,
    "workload": {
      "file_count": 1000,
      "file_size_bytes": 1048576,
      "concurrent_clients": 10
    },
    "note": "Raw benchmark numbers without subjective claims. All systems tested with identical workload parameters on the same hardware."
  }
}
```

## Metrics Explained

- **throughput_mbps**: Megabytes per second written to storage
- **latency_p50_ms**: Median latency (50th percentile) in milliseconds
- **latency_p95_ms**: 95th percentile latency in milliseconds
- **latency_p99_ms**: 99th percentile latency in milliseconds
- **cpu_percent_avg**: Average CPU usage percentage
- **memory_mb_peak**: Peak memory usage in megabytes
- **error_rate**: Fraction of operations that failed (0.0 = no errors)

## Best Practices

1. **Identical Hardware**: Run all benchmarks on the same machine with the same hardware configuration
2. **Isolated Environment**: Close other applications to minimize interference
3. **Multiple Runs**: Run each benchmark multiple times and average the results
4. **Warmup**: Always include a warmup period to allow caches to stabilize
5. **Same Workload**: Use identical file sizes and concurrency levels across all systems
6. **Document Configuration**: Record all system configurations (OS, filesystem, database settings)

## Interpreting Results

The benchmark suite provides **raw numbers only** without subjective claims. When comparing results:

- Higher throughput (MB/s) is better
- Lower latency (ms) is better
- Lower CPU usage is better (more efficient)
- Lower memory usage is better (more efficient)
- Lower error rate is better (more reliable)

Consider your specific use case when evaluating results. Different systems may excel in different scenarios (e.g., small files vs. large files, high concurrency vs. low concurrency).

## Troubleshooting

### MongoDB Connection Failed
- Ensure MongoDB is running: `mongod --dbpath ./mongodb-data`
- Check connection string matches your MongoDB configuration

### PostgreSQL Connection Failed
- Ensure PostgreSQL is running: `pg_ctl status`
- Verify database exists: `psql -l`
- Check connection string credentials

### Filesystem Permission Errors
- Ensure data directories are writable
- Check disk space availability

### High Error Rates
- Reduce concurrency level
- Increase system resources
- Check system logs for errors

## License

This benchmark suite is part of ShrikDB and follows the same license.
