# Design Document

## Overview

ShrikDB Phase 1A is a production-ready event-sourced database system built around an immutable, append-only Write-Ahead Log (WAL). The system provides strong consistency guarantees through deterministic event ordering, cryptographic integrity verification, and crash-safe writes. The architecture follows event sourcing principles where the WAL serves as the single source of truth, and all application state is derived through deterministic replay of events.

The system consists of a Go-based backend providing REST APIs for event operations, and a TypeScript/React frontend that interacts exclusively with real backend APIs. No mock data, fake state, or client-side mutations are permitted - all state changes must flow through the event log.

## Architecture

### High-Level Architecture

```
┌─────────────────┐    HTTP/REST    ┌─────────────────┐
│   Frontend      │ ──────────────► │   HTTP Server   │
│   (React/TS)    │                 │   (Go)          │
└─────────────────┘                 └─────────────────┘
                                             │
                                             ▼
                                    ┌─────────────────┐
                                    │   API Service   │
                                    │   (Go)          │
                                    └─────────────────┘
                                             │
                                    ┌────────┴────────┐
                                    ▼                 ▼
                            ┌─────────────┐   ┌─────────────┐
                            │ Auth Store  │   │ WAL Engine  │
                            │ (Go)        │   │ (Go)        │
                            └─────────────┘   └─────────────┘
                                                     │
                                                     ▼
                                            ┌─────────────┐
                                            │ Replay      │
                                            │ Engine      │
                                            │ (Go)        │
                                            └─────────────┘
                                                     │
                                                     ▼
                                            ┌─────────────┐
                                            │ File System │
                                            │ (WAL Files) │
                                            └─────────────┘
```

### Component Interaction Flow

1. **Frontend → HTTP Server**: All user actions trigger HTTP requests with authentication headers
2. **HTTP Server → API Service**: Requests are validated, rate-limited, and forwarded with correlation IDs
3. **API Service → Auth Store**: Credentials are validated using production-grade hashing
4. **API Service → WAL Engine**: Authenticated requests append events or read from the log
5. **WAL Engine → File System**: Events are written with fsync for durability
6. **Replay Engine**: Processes events deterministically for integrity verification

## Components and Interfaces

### WAL Engine (`pkg/wal`)

**Purpose**: Provides durable, append-only event storage with crash safety.

**Key Interfaces**:
```go
type WAL interface {
    Append(projectID, eventType string, payload json.RawMessage, metadata map[string]string) (*Event, error)
    ReadEvents(projectID string, fromSequence uint64) ([]*Event, error)
    ReadEventsStream(projectID string, fromSequence uint64, ch chan<- *Event) error
    GetProjectSequence(projectID string) (uint64, error)
    Close() error
}
```

**Responsibilities**:
- Sequential disk writes with configurable fsync behavior
- Per-project isolation via separate log files
- Crash recovery through partial write detection and truncation
- Monotonic sequence number assignment
- Event integrity verification during reads

### Event Model (`pkg/event`)

**Purpose**: Defines the canonical immutable event structure.

**Key Interfaces**:
```go
type Event struct {
    EventID        string            `json:"event_id"`
    ProjectID      string            `json:"project_id"`
    EventType      string            `json:"event_type"`
    Payload        json.RawMessage   `json:"payload"`
    PayloadHash    string            `json:"payload_hash"`
    SequenceNumber uint64            `json:"sequence_number"`
    Timestamp      time.Time         `json:"timestamp"`
    PreviousHash   string            `json:"previous_hash,omitempty"`
    Metadata       map[string]string `json:"metadata,omitempty"`
}
```

**Responsibilities**:
- Immutable event creation with server-assigned fields
- Cryptographic integrity verification (SHA-256)
- Event chaining through previous hash references
- JSON serialization/deserialization with canonical formatting
- Comprehensive validation of all fields

### API Service (`pkg/api`)

**Purpose**: Provides internal API surface for event operations.

**Key Interfaces**:
```go
type Service interface {
    AppendEvent(ctx context.Context, req *AppendEventRequest) (*AppendEventResponse, error)
    ReadEvents(ctx context.Context, req *ReadEventsRequest) (*ReadEventsResponse, error)
    Replay(ctx context.Context, req *ReplayRequest) (*ReplayResponse, error)
    CreateProject(ctx context.Context, req *CreateProjectRequest) (*CreateProjectResponse, error)
}
```

**Responsibilities**:
- Request validation and authentication
- Project isolation enforcement
- Metrics collection for observability
- Error handling and logging

### HTTP Server (`pkg/server`)

**Purpose**: Exposes REST endpoints with production middleware.

**Key Endpoints**:
- `POST /api/events` - Append events
- `GET /api/events/read` - Read events with pagination
- `POST /api/replay` - Trigger replay/verification
- `POST /api/projects` - Create new projects
- `GET /health` - Health check
- `GET /metrics` - Prometheus metrics

**Responsibilities**:
- HTTP request/response handling
- Authentication header validation
- Rate limiting per client
- Request correlation and structured logging
- Middleware chain (auth, rate limiting, logging)

### Authentication (`pkg/auth`)

**Purpose**: Provides production-grade authentication and authorization.

**Key Interfaces**:
```go
type Store interface {
    CreateProject(projectID string) (clientID, clientKey string, error)
    ValidateCredentials(clientID, clientKey string) (*AuthContext, error)
}
```

**Responsibilities**:
- Secure credential generation and storage
- bcrypt/argon2 password hashing
- Constant-time credential validation
- Rate limiting and audit logging
- Key rotation support

### Replay Engine (`pkg/replay`)

**Purpose**: Provides deterministic event replay for integrity verification.

**Key Interfaces**:
```go
type Engine interface {
    ReplayFrom(ctx context.Context, projectID string, fromSequence uint64, handler EventHandler) (*Progress, error)
    VerifyIntegrity(ctx context.Context, projectID string) (*Progress, error)
}
```

**Responsibilities**:
- Sequential event processing with progress tracking
- Hash chain integrity verification
- Error detection and reporting
- Deterministic state rebuilding (future phases)

### Frontend Client (`api-client.ts`)

**Purpose**: Provides type-safe HTTP client for backend APIs.

**Key Interfaces**:
```typescript
interface ShrikDBClient {
    createProject(projectID: string): Promise<CreateProjectResponse>
    appendEvent(eventType: string, payload: any, metadata?: Record<string, string>): Promise<AppendEventResponse>
    readEvents(fromSequence?: number, limit?: number): Promise<ReadEventsResponse>
    replay(fromSequence?: number, verifyOnly?: boolean): Promise<ReplayResponse>
}
```

**Responsibilities**:
- HTTP request/response handling with proper error handling
- Authentication header management
- Credential storage in localStorage
- Request correlation ID logging
- Type-safe API interactions

### State Management (`store.ts`)

**Purpose**: Manages frontend application state derived from events.

**Key Interfaces**:
```typescript
interface AppState {
    // Authentication state
    isAuthenticated: boolean
    currentProject: string | null
    
    // Derived state (from events)
    documents: Document[]
    streams: string[]
    // ... other projections
    
    // Actions (all create events)
    addDocument(collection: string, content: any): Promise<void>
    publishMessage(stream: string, payload: any): Promise<void>
    // ... other event-creating actions
}
```

**Responsibilities**:
- Event-driven state management (no direct mutations)
- State rebuilding from event log through `rebuildStateFromEvents()`
- All write operations must create events first
- Loading and error state management

## Data Models

### Event Structure

Events are the fundamental unit of data in ShrikDB. Each event is immutable and contains:

- **EventID**: Globally unique, time-sortable identifier (timestamp + UUID)
- **ProjectID**: Tenant isolation boundary
- **EventType**: Semantic event classification (e.g., "document.created")
- **Payload**: JSON event data (max 1MB)
- **PayloadHash**: SHA-256 hash of canonical JSON payload
- **SequenceNumber**: Monotonic per-project counter (starts at 1)
- **Timestamp**: Server-generated, monotonic within project
- **PreviousHash**: SHA-256 hash of previous event (for chaining)
- **Metadata**: Optional key-value pairs for tracing/context

### Project Isolation

Projects provide strong tenant isolation:

- Each project has independent event sequences
- WAL files are stored in separate directories: `data/projects/{projectID}/events.wal`
- Authentication credentials are project-scoped
- Sequence numbers are independent per project
- Replay operations are project-scoped

### File System Layout

```
data/
├── projects/
│   ├── project-a/
│   │   └── events.wal
│   ├── project-b/
│   │   └── events.wal
│   └── ...
└── auth/
    └── credentials.db
```

### Event Types and Payloads

Standard event types for Phase 1A:

- `document.created`: Document creation with collection and content
- `document.deleted`: Document deletion with ID
- `message.published`: Stream message with payload
- `cache.set`: Cache key-value with TTL
- `cache.deleted`: Cache key deletion
- `file.uploaded`: File metadata storage
- `alert.created`: Alert rule creation

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### WAL Durability and Integrity Properties

**Property 1: Event persistence after fsync**
*For any* event written to the WAL, after fsync completes, the event should be recoverable after system restart
**Validates: Requirements 1.1, 7.1**

**Property 2: WAL immutability**
*For any* sequence of events written to the WAL, attempting to modify existing events should be detected as corruption
**Validates: Requirements 1.2**

**Property 3: Monotonic sequence numbers**
*For any* project, events should have strictly increasing sequence numbers with no gaps
**Validates: Requirements 1.3**

**Property 4: Hash chain integrity**
*For any* event in the WAL, its previous_hash should match the computed hash of the actual previous event
**Validates: Requirements 1.4**

**Property 5: Crash recovery truncation**
*For any* WAL with partial writes, system restart should detect corruption and truncate to the last valid event
**Validates: Requirements 1.5, 7.2, 7.3**

**Property 6: Concurrent write serialization**
*For any* set of concurrent write operations, the resulting sequence numbers should be monotonic and consistent
**Validates: Requirements 7.5**

### Replay and Determinism Properties

**Property 7: Deterministic replay ordering**
*For any* project's events, replay should process them in sequence number order regardless of storage order
**Validates: Requirements 2.1**

**Property 8: Replay idempotence**
*For any* project, multiple replay executions should produce identical final state
**Validates: Requirements 2.2**

**Property 9: Complete state recovery**
*For any* project with deleted projections, system restart should rebuild identical state from WAL
**Validates: Requirements 2.3**

**Property 10: Replay progress reporting**
*For any* replay operation, progress metrics should accurately reflect events processed and completion status
**Validates: Requirements 2.4**

**Property 11: Corruption detection during replay**
*For any* WAL with corrupted event hashes, replay should halt and report the exact corruption location
**Validates: Requirements 2.5**

### Project Isolation Properties

**Property 12: Project authorization enforcement**
*For any* authenticated client, appending events to a different project should be rejected
**Validates: Requirements 3.1**

**Property 13: Project data isolation**
*For any* authenticated client, queries should return only events from their authorized project
**Validates: Requirements 3.2**

**Property 14: Independent project sequences**
*For any* set of projects, each should maintain independent sequence numbers starting from 1
**Validates: Requirements 3.3**

**Property 15: Project replay isolation**
*For any* project replay operation, it should not affect other projects' state or sequences
**Validates: Requirements 3.4**

### Authentication and Security Properties

**Property 16: Secure credential hashing**
*For any* created project credentials, they should be hashed using bcrypt or argon2
**Validates: Requirements 4.1**

**Property 17: Authentication failure logging**
*For any* failed authentication attempt, it should be logged with timestamp, client ID, and failure reason
**Validates: Requirements 4.2, 6.5**

**Property 18: Rate limiting enforcement**
*For any* client exceeding authentication rate limits, requests should be rejected with appropriate error codes
**Validates: Requirements 4.3**

**Property 19: Multiple key support**
*For any* project with multiple valid keys, all keys should work for authentication simultaneously
**Validates: Requirements 4.5**

### Frontend Integration Properties

**Property 20: Frontend API integration**
*For any* frontend write action, it should result in a call to the AppendEvent API endpoint
**Validates: Requirements 5.1**

**Property 21: Backend-derived state**
*For any* data displayed in the frontend, it should be traceable to events from backend API responses
**Validates: Requirements 5.2**

**Property 22: Real event ID generation**
*For any* created event, the returned event ID should follow the expected format and be globally unique
**Validates: Requirements 5.3**

### Observability Properties

**Property 23: Structured logging format**
*For any* system operation, logs should be in JSON format with correlation IDs
**Validates: Requirements 6.1**

**Property 24: Metrics endpoint content**
*For any* metrics query, the response should include events per second, write latency, and replay duration
**Validates: Requirements 6.2**

**Property 25: Health check completeness**
*For any* health check request, the response should include WAL status, replay status, and overall health
**Validates: Requirements 6.3**

**Property 26: Error logging context**
*For any* WAL operation error, the log should include operation type and affected project
**Validates: Requirements 6.4**

### Configuration and Environment Properties

**Property 27: Environment variable configuration**
*For any* system startup, configuration should be loaded from environment variables
**Validates: Requirements 8.1**

**Property 28: WAL directory validation**
*For any* configured WAL directory, the system should validate it exists and is writable
**Validates: Requirements 8.3**

**Property 29: Environment-specific settings**
*For any* environment configuration, different settings should affect system behavior appropriately
**Validates: Requirements 8.4**

### Testing and Verification Properties

**Property 30: Real API integration tests**
*For any* integration test execution, it should make actual API calls rather than using mocks
**Validates: Requirements 9.2**

**Property 31: Crash recovery test simulation**
*For any* crash recovery test, it should simulate actual crashes and verify recovery behavior
**Validates: Requirements 9.3**

**Property 32: Replay determinism testing**
*For any* replay determinism test, it should run multiple replays and verify identical results
**Validates: Requirements 9.4**

**Property 33: Performance benchmark measurement**
*For any* performance benchmark, it should measure and report write throughput and replay speed
**Validates: Requirements 9.5**

**Property 34: Verification script real endpoints**
*For any* verification script execution, it should test against real API endpoints
**Validates: Requirements 10.1**

**Property 35: WAL file inspection**
*For any* verification of WAL data, it should inspect actual WAL files without mocks
**Validates: Requirements 10.2**

**Property 36: End-to-end frontend verification**
*For any* frontend action verification, it should confirm real events are created in the backend
**Validates: Requirements 10.3**

**Property 37: Projection deletion recovery**
*For any* projection deletion test, system restart should rebuild state perfectly from WAL
**Validates: Requirements 10.4**

**Property 38: Verification status reporting**
*For any* verification completion, it should report pass or fail status for all Phase 1A requirements
**Validates: Requirements 10.5**

<function_calls>
<invoke name="prework">
<parameter name="featureName">shrikdb-phase-1a

## Error Handling

### WAL Error Handling

**Corruption Detection**: The system detects corruption through:
- Hash verification during reads
- Partial write detection on startup
- Chain integrity verification during replay

**Recovery Strategies**:
- Partial writes: Truncate to last valid event
- Hash mismatches: Halt operations and log corruption location
- File system errors: Retry with exponential backoff, then fail fast

**Error Propagation**: WAL errors are propagated up through the API layer with structured error responses and correlation IDs for tracing.

### Authentication Error Handling

**Invalid Credentials**: Return 401 Unauthorized with audit logging
**Rate Limiting**: Return 429 Too Many Requests with retry-after headers
**Project Mismatches**: Return 403 Forbidden with detailed error messages

### API Error Handling

**Request Validation**: Return 400 Bad Request for malformed requests
**Server Errors**: Return 500 Internal Server Error with correlation IDs
**Timeout Handling**: Implement request timeouts with graceful degradation

### Frontend Error Handling

**Network Errors**: Retry with exponential backoff, show user-friendly messages
**Authentication Errors**: Clear credentials and redirect to project creation
**API Errors**: Display error messages with correlation IDs for support

## Testing Strategy

### Dual Testing Approach

The system employs both unit testing and property-based testing for comprehensive coverage:

- **Unit tests** verify specific examples, edge cases, and error conditions
- **Property tests** verify universal properties that should hold across all inputs
- Together they provide comprehensive coverage: unit tests catch concrete bugs, property tests verify general correctness

### Property-Based Testing

**Library**: Go's `testing/quick` package with custom generators for complex types
**Configuration**: Each property-based test runs a minimum of 100 iterations
**Tagging**: Each property-based test includes a comment explicitly referencing the correctness property from the design document

**Example Property Test Format**:
```go
// **Feature: shrikdb-phase-1a, Property 3: Monotonic sequence numbers**
func TestMonotonicSequenceNumbers(t *testing.T) {
    quick.Check(func(events []EventData) bool {
        // Test implementation
    }, &quick.Config{MaxCount: 100})
}
```

### Unit Testing

**Coverage Areas**:
- Event creation and validation
- WAL file operations
- Authentication flows
- API request/response handling
- Error conditions and edge cases

**Integration Testing**:
- End-to-end API flows with real HTTP calls
- WAL persistence and recovery scenarios
- Authentication and authorization flows
- Frontend-backend integration without mocks

### Performance Testing

**Benchmarks**:
- Write throughput (events per second)
- Read latency percentiles
- Replay speed (events processed per second)
- Memory usage during large replays

### Crash Testing

**Scenarios**:
- Partial write simulation
- Unexpected shutdown during writes
- File system corruption
- Network interruption during API calls

## Production Configuration

### Environment Variables

**Required Configuration**:
```bash
SHRIKDB_DATA_DIR=/var/lib/shrikdb
SHRIKDB_PORT=8080
SHRIKDB_LOG_LEVEL=info
SHRIKDB_SYNC_MODE=always
```

**Optional Configuration**:
```bash
SHRIKDB_RATE_LIMIT=100
SHRIKDB_MAX_PAYLOAD_SIZE=1048576
SHRIKDB_BATCH_SIZE=100
SHRIKDB_BATCH_TIMEOUT=100ms
```

### Security Configuration

**Secrets Management**:
- All secrets loaded from environment variables
- No secrets in configuration files or source code
- Support for external secret management systems

**TLS Configuration** (Future):
- Certificate paths via environment variables
- Automatic certificate rotation support

### Logging Configuration

**Structured Logging**:
- JSON format for machine parsing
- Correlation IDs for request tracing
- Configurable log levels per component

**Log Rotation**:
- Size-based rotation (100MB default)
- Retention policy (30 days default)
- Compression for archived logs

### Monitoring Configuration

**Metrics Export**:
- Prometheus format at `/metrics` endpoint
- Custom metrics for business logic
- Health checks at `/health` and `/ready`

**Alerting Integration**:
- Support for external monitoring systems
- Configurable alert thresholds
- Webhook notifications for critical events

### Backup and Recovery

**WAL Backup Procedure**:
1. Stop write operations (maintenance mode)
2. Copy WAL files to backup location
3. Verify backup integrity
4. Resume operations

**Recovery Procedure**:
1. Stop ShrikDB service
2. Restore WAL files from backup
3. Start service (automatic recovery will run)
4. Verify system health

**Automated Backup**:
- Configurable backup schedules
- Incremental backup support
- Remote backup storage integration

### Deployment Considerations

**Resource Requirements**:
- Minimum 2GB RAM for production
- SSD storage recommended for WAL
- Network bandwidth for API traffic

**Scaling Considerations**:
- Single-node deployment for Phase 1A
- Horizontal scaling planned for future phases
- Load balancer configuration for high availability

**Container Deployment**:
- Docker image with minimal base
- Health check endpoints for orchestration
- Graceful shutdown handling

This design provides a solid foundation for implementing ShrikDB Phase 1A as a production-ready event-sourced database system with strong consistency guarantees, comprehensive observability, and robust error handling.