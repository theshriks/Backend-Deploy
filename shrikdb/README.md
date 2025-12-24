# ShrikDB Phase 1A — The Spine

Production-grade immutable, append-only event log core.

## Overview

ShrikDB Phase 1A implements the foundational event sourcing infrastructure:
- **Immutable Events**: Once written, events cannot be modified or deleted
- **Append-Only Log**: Sequential writes with crash-safe durability
- **Deterministic Replay**: Rebuild any state from the event log
- **Project Isolation**: Multi-tenant with per-project authentication

This is the **single source of truth** for all future ShrikDB layers.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        API Layer                            │
│  appendEvent() │ readEvents() │ replay() │ createProject()  │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                     Authentication                          │
│         Client ID + Client Key │ Project Isolation          │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                      Replay Engine                          │
│    Deterministic │ Idempotent │ Integrity Verification      │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                    Write-Ahead Log                          │
│      Sequential Writes │ fsync │ Crash Recovery             │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                         Disk                                │
│              data/projects/{project_id}/events.wal          │
└─────────────────────────────────────────────────────────────┘
```

## Event Model

Every event contains:

```json
{
  "event_id": "0194abc123def456...",     // Sortable unique ID (timestamp + UUID)
  "project_id": "my-project",            // Tenant isolation
  "event_type": "user.created",          // Event classification
  "payload": {"user_id": "u1", ...},     // Actual data (JSON)
  "payload_hash": "sha256:abc123...",    // Deterministic integrity hash
  "sequence_number": 42,                 // Monotonic per project
  "timestamp": "2024-01-15T10:30:00Z",   // Server-generated, monotonic
  "previous_hash": "sha256:def456...",   // Chain integrity (optional)
  "metadata": {"source": "api"}          // Auxiliary data (optional)
}
```

### Guarantees

| Property | Guarantee |
|----------|-----------|
| Immutability | Events are never modified or deleted |
| Ordering | Strict sequence per project, no gaps |
| Durability | fsync after each write (configurable) |
| Integrity | SHA-256 hash of canonicalized payload |
| Determinism | Same payload always produces same hash |

## Log Format

Events are stored as **JSON Lines** (one JSON object per line):

```
data/
└── projects/
    └── {project_id}/
        └── events.wal          # Append-only event log
```

Example `events.wal`:
```json
{"event_id":"...","project_id":"demo","event_type":"user.created","payload":{"user_id":"u1"},"payload_hash":"abc...","sequence_number":1,"timestamp":"2024-01-15T10:30:00Z"}
{"event_id":"...","project_id":"demo","event_type":"user.updated","payload":{"name":"Alice"},"payload_hash":"def...","sequence_number":2,"timestamp":"2024-01-15T10:30:01Z","previous_hash":"abc..."}
```

**Why JSON Lines?**
- Human-readable and debuggable
- Easy to inspect with standard tools (`cat`, `jq`, `grep`)
- Simple crash recovery (truncate incomplete lines)
- No binary format complexity

## Replay Guarantees

The replay engine provides:

1. **Determinism**: Replaying the same events always produces identical results
2. **Idempotency**: Multiple replays are safe and produce the same outcome
3. **Integrity Verification**: Each event's hash is verified during replay
4. **Chain Verification**: Previous hash linkage is validated
5. **Progress Reporting**: Observable replay with metrics

### Recovery Path

If anything breaks, replay is the recovery mechanism:

```go
// Rebuild all state from events
progress, err := replay.Replay(ctx, projectID, func(evt *event.Event) error {
    // Rebuild your state here
    return nil
})
```

## Failure Recovery

### Crash During Write

1. Partial JSON line detected on restart
2. Corrupt line is truncated
3. Sequence continues from last valid event
4. No data loss for committed events

### Corrupt Event Detection

1. Payload hash mismatch detected
2. Event flagged in replay errors
3. Chain integrity broken from that point
4. Manual intervention required

### Safe Restart

1. WAL files are scanned on startup
2. Last sequence number recovered
3. Last event hash recovered for chaining
4. Ready to accept new writes

## API Reference

### Internal APIs (Phase 1A)

```go
// Create a new project with credentials
CreateProject(projectID string) -> (clientID, clientKey, error)

// Append an event to the log
AppendEvent(clientID, clientKey, eventType string, payload JSON) -> (Event, error)

// Read events from offset
ReadEvents(clientID, clientKey string, fromSequence uint64) -> ([]Event, error)

// Replay events with handler
Replay(clientID, clientKey string, handler func(Event) error) -> (Progress, error)
```

## Configuration

### Sync Modes

| Mode | Durability | Performance | Use Case |
|------|------------|-------------|----------|
| `always` | Highest | Slowest | Production default |
| `batch` | High | Medium | High throughput |
| `none` | Lowest | Fastest | Development only |

### Environment Variables

```bash
SHRIKDB_DATA_DIR=./data       # Data directory
SHRIKDB_SYNC_MODE=always      # Sync mode
SHRIKDB_LOG_LEVEL=info        # Log level
```

## Running

### Build

```bash
cd shrikdb
go mod tidy
go build -o shrikdb ./cmd/shrikdb
```

### Run Demo

```bash
./shrikdb -demo
```

### Run Tests

```bash
go test ./... -v
```

### Production

```bash
./shrikdb -data /var/lib/shrikdb -sync always -log-level info
```

## Testing

Tests cover:

- **Append Correctness**: Events are written with correct sequence numbers
- **Crash Recovery**: State survives restarts, partial writes handled
- **Replay Determinism**: Multiple replays produce identical results
- **Ordering Guarantees**: Strict monotonic sequence per project
- **Integrity Verification**: Hash validation catches tampering
- **Project Isolation**: Tenants cannot access each other's data

Run all tests:
```bash
go test ./pkg/... -v -race
```

## Observability

### Structured Logs

All operations emit structured logs:

```json
{"level":"info","component":"wal","project_id":"demo","event_id":"...","sequence":1,"msg":"event appended"}
{"level":"info","component":"replay","project_id":"demo","events_processed":100,"duration":"15ms","msg":"replay complete"}
```

### Metrics

Available metrics:
- `events_appended` - Total events written
- `bytes_written` - Total bytes written to WAL
- `syncs_performed` - Number of fsync calls
- `errors_encountered` - Error count
- `append_latency_ns` - Last append latency

## Security

### Authentication Model

- Each project has `client_id` + `client_key`
- Keys are hashed before storage
- Constant-time comparison prevents timing attacks
- Keys can be rotated without data loss

### Isolation

- Projects are completely isolated
- No cross-project data access
- Credentials scoped to single project

## What's NOT in Phase 1A

- Document queries (Phase 1B)
- Mongo-like collections
- Kafka-style consumers
- Redis cache layer
- IPFS storage
- HTTP/gRPC server (internal APIs only)

## Design Decisions

### Why Go?

- Excellent concurrency primitives
- Strong standard library for I/O
- Simple deployment (single binary)
- Good performance for I/O-bound workloads

### Why JSON Lines?

- Human-readable for debugging
- Simple crash recovery
- No schema evolution complexity
- Standard tooling support

### Why fsync per write?

- Durability over performance
- Production workloads require guarantees
- Configurable for development

### Why per-project files?

- Natural isolation
- Simple backup/restore per tenant
- No cross-tenant locking

## License

Internal use only - ShrikDB Phase 1A
