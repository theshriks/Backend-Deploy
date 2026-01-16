# Design Document

## Overview

ShrikDB Phase 4B delivers a production-hardened, fully integrated system where Frontend (React), Backend (Node.js), and ShrikDB Core (Go WAL engine) operate as a single coherent platform. This design eliminates all mocks, simulations, and fake data, ensuring every metric, event, and signal is real and measurable. The system enforces the WAL as the single source of truth with no bypass paths, provides minimal diagnostic UI for production observability, and guarantees deterministic recovery with exactly-once processing semantics.

The architecture follows a strict layering:
- **ShrikDB Core (Go)**: WAL engine, event storage, sequence assignment, tenant isolation
- **Backend (Node.js)**: API gateway, authentication, quota management, WebSocket coordination
- **Frontend (React)**: User interface, real-time event display, metrics visualization

All writes flow through the WAL AppendEvent API. All reads derive from WAL events. All state is recoverable from sequence 0.

## Architecture

### System Components

```
┌─────────────────────────────────────────────────────────────┐
│                         Frontend (React)                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Event Log    │  │ Metrics      │  │ Health       │      │
│  │ Viewer       │  │ Panel        │  │ Panel        │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│         │                  │                  │              │
│         └──────────────────┴──────────────────┘              │
│                            │                                 │
│                     HTTP + WebSocket                         │
└────────────────────────────┼────────────────────────────────┘
                             │
┌────────────────────────────┼────────────────────────────────┐
│                  Backend (Node.js)                           │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Unified Backend API (port 3001)                      │   │
│  │  - Authentication & Authorization                    │   │
│  │  - Quota Management & Backpressure                   │   │
│  │  - Tenant Isolation Enforcement                      │   │
│  │  - Latency Tracking & Metrics Aggregation           │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ WebSocket Server (port 3002)                         │   │
│  │  - Real-time Event Broadcasting                      │   │
│  │  - Authenticated Connections                         │   │
│  │  - Log Streaming                                     │   │
│  └──────────────────────────────────────────────────────┘   │
│                            │                                 │
│                     HTTP (ShrikDB API)                       │
└────────────────────────────┼────────────────────────────────┘
                             │
┌────────────────────────────┼────────────────────────────────┐
│                  ShrikDB Core (Go)                           │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ HTTP API Server (port 8080)                          │   │
│  │  - /api/events (AppendEvent)                         │   │
│  │  - /api/events/read (ReadEvents)                     │   │
│  │  - /api/replay (Replay from sequence 0)              │   │
│  │  - /metrics (Prometheus metrics)                     │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ WAL Engine                                           │   │
│  │  - Append-only event log                             │   │
│  │  - Sequence number assignment                        │   │
│  │  - Tenant/namespace scoping                          │   │
│  │  - Cryptographic hashing                             │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Projection Engine                                    │   │
│  │  - Document store (derived from events)              │   │
│  │  - Query engine                                      │   │
│  │  - Replay handler                                    │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Tenant Manager                                       │   │
│  │  - Tenant state tracking                             │   │
│  │  - Namespace management                              │   │
│  │  - Access control                                    │   │
│  └──────────────────────────────────────────────────────┘   │
│                            │                                 │
│                    Filesystem (WAL files)                    │
└────────────────────────────┼────────────────────────────────┘
                             │
                    ┌────────┴────────┐
                    │  data/projects/ │
                    │  ├── project-1/ │
                    │  │   └── events.wal
                    │  └── project-2/ │
                    │      └── events.wal
                    └─────────────────┘
```

### Data Flow

**Write Path (User Action → WAL)**:
```
1. User clicks "Create Document" in Frontend
2. Frontend sends POST /api/documents to Backend
3. Backend validates auth, enforces quotas
4. Backend calls ShrikDB POST /api/events (AppendEvent)
5. ShrikDB WAL assigns sequence number, writes to disk
6. ShrikDB returns Event{sequence, timestamp, hash}
7. Backend returns success to Frontend
8. WebSocket broadcasts event to all connected clients
9. Frontend updates UI with new event
```

**Read Path (Query → Projection)**:
```
1. User opens "Documents" page in Frontend
2. Frontend sends GET /api/documents to Backend
3. Backend calls ShrikDB GET /api/events/read
4. ShrikDB reads events from WAL, filters by tenant
5. ShrikDB returns events array
6. Backend filters by collection, maps to documents
7. Backend returns documents to Frontend
8. Frontend displays documents in UI
```

**Replay Path (Recovery → Consistency)**:
```
1. Admin triggers replay from Frontend
2. Frontend sends POST /api/replay to Backend
3. Backend calls ShrikDB POST /api/replay
4. ShrikDB reads all events from sequence 0
5. ShrikDB rebuilds projections (documents, streams)
6. ShrikDB verifies sequence monotonicity
7. ShrikDB returns replay progress
8. Backend returns status to Frontend
9. Frontend displays replay progress
```

## Components and Interfaces

### ShrikDB Core (Go)

**Purpose**: WAL engine, event storage, sequence assignment, tenant isolation

**Key Interfaces**:

```go
// AppendEvent - Primary write path
POST /api/events
Request: {
  client_id: string,
  client_key: string,
  project_id: string,
  tenant_id: string,
  namespace: string,
  event_type: string,
  payload: json,
  metadata: map[string]string
}
Response: {
  event: {
    event_id: string,
    sequence_number: uint64,
    tenant_sequence_number: uint64,
    timestamp: string,
    hash: string
  },
  success: bool
}

// ReadEvents - Primary read path
GET /api/events/read?from_sequence=0&limit=100
Request: {
  client_id: string,
  client_key: string,
  project_id: string,
  tenant_id: string,
  namespace: string,
  from_sequence: uint64,
  limit: int
}
Response: {
  events: [Event],
  count: int,
  success: bool
}

// Replay - Recovery path
POST /api/replay
Request: {
  client_id: string,
  client_key: string,
  project_id: string,
  from_sequence: uint64,
  verify_only: bool
}
Response: {
  progress: {
    processed_events: uint64,
    current_sequence: uint64,
    errors: []string
  },
  success: bool
}

// Metrics - Observability
GET /metrics
Response: Prometheus-format metrics
```

**Internal Components**:

1. **WAL Engine** (`pkg/wal`):
   - Append-only log with fsync guarantees
   - Sequence number assignment (monotonic, gapless)
   - Tenant/namespace scoping
   - Cryptographic hashing (SHA-256)
   - File rotation and compaction

2. **Projection Engine** (`pkg/projection`):
   - Rebuilds document store from events
   - Handles replay from sequence 0
   - Maintains derived state (documents, streams)

3. **Tenant Manager** (`pkg/tenant`):
   - Tracks tenant state
   - Enforces namespace isolation
   - Validates access control

4. **Auth Store** (`pkg/auth`):
   - Validates client credentials
   - Manages project access
   - Enforces tenant boundaries

### Backend (Node.js)

**Purpose**: API gateway, authentication, quota management, WebSocket coordination

**Key Interfaces**:

```javascript
// Document Operations
POST /api/documents
GET /api/documents
PUT /api/documents/:id
DELETE /api/documents/:id

// Stream Operations
POST /api/streams/publish
GET /api/streams/consume
POST /api/streams/subscribe
POST /api/streams/commit-offset

// Metrics & Monitoring
GET /api/metrics
GET /api/metrics/realtime
GET /api/workers
GET /api/partitions

// Recovery & Replay
POST /api/replay
GET /api/recovery/status
POST /api/recovery/verify

// Authentication
POST /api/auth/login
POST /api/auth/logout

// Health
GET /health
GET /ready
```

**Internal Components**:

1. **UnifiedBackendAPI** (`unified-backend-api.js`):
   - Express server on port 3001
   - CORS configuration for frontend
   - Request logging with correlation IDs
   - Retry logic with exponential backoff
   - Latency tracking for metrics

2. **AuthenticationService** (`authentication-service.js`):
   - Session management
   - Credential validation
   - Project-based access control

3. **QuotaManager** (`quota-manager.js`):
   - Rate limiting per tenant/namespace
   - Backpressure application
   - Quota violation tracking

4. **TenantIsolationService** (`tenant-isolation.js`):
   - Event filtering by tenant
   - Cross-tenant access prevention
   - Security violation logging

5. **LatencyTracker**:
   - Sliding window of latency samples
   - P50/P99 percentile calculation
   - Per-operation tracking (append, read, replay)

6. **WebSocketServer** (`websocket-server.js`):
   - WebSocket server on port 3002
   - Authenticated connections (client_id/client_key)
   - Real-time log broadcasting
   - Connection management with ping/pong

### Frontend (React)

**Purpose**: User interface, real-time event display, metrics visualization

**Key Components**:

1. **Event Log Viewer** (New - Phase 4B):
   - Displays real-time events from WAL
   - Shows sequence number, event type, project_id, timestamp
   - Filters by project/tenant/namespace
   - WebSocket connection for live updates
   - Read-only (no write operations)

2. **Metrics Panel** (Enhanced - Phase 4B):
   - Real throughput (events/sec from backend)
   - Append latency (P50/P99 from backend)
   - Read latency (P50/P99 from backend)
   - Replay speed (events/sec during replay)
   - Worker/partition status (if available)
   - Storage used (WAL size from backend)

3. **Health Panel** (New - Phase 4B):
   - Authentication failures (from backend)
   - Quota violations (from backend)
   - Replay errors (from backend)
   - Service health indicators (ShrikDB, Backend, WebSocket)
   - Connection status (connected/disconnected)

4. **Existing Pages** (Enhanced):
   - Dashboard: Real metrics (no mocks)
   - Documents: Real CRUD via backend
   - Streams: Real pub/sub via backend
   - Monitoring: Real-time logs via WebSocket

**State Management** (`store.ts`):
```typescript
interface AppState {
  // Authentication
  isAuthenticated: boolean;
  currentProject: string | null;
  clientId: string | null;
  clientKey: string | null;
  
  // Real-time events
  events: Event[];
  eventCount: number;
  
  // Metrics (real, not mock)
  metrics: {
    eventsPerSecond: number;
    appendLatencyP50: number;
    appendLatencyP99: number;
    readLatencyP50: number;
    readLatencyP99: number;
    storageUsedBytes: number;
  };
  
  // Health
  health: {
    shrikdb: 'healthy' | 'unhealthy';
    backend: 'healthy' | 'unhealthy';
    websocket: 'connected' | 'disconnected';
  };
  
  // Errors
  authFailures: AuthFailure[];
  quotaViolations: QuotaViolation[];
  replayErrors: ReplayError[];
}
```

## Data Models

### Event (Core Data Structure)

```go
type Event struct {
    EventID              string            `json:"event_id"`
    SequenceNumber       uint64            `json:"sequence_number"`
    TenantSequenceNumber uint64            `json:"tenant_sequence_number"`
    ProjectID            string            `json:"project_id"`
    TenantID             string            `json:"tenant_id"`
    Namespace            string            `json:"namespace"`
    EventType            string            `json:"event_type"`
    Payload              json.RawMessage   `json:"payload"`
    Metadata             map[string]string `json:"metadata"`
    Timestamp            time.Time         `json:"timestamp"`
    Hash                 string            `json:"hash"`
    CorrelationID        string            `json:"correlation_id"`
    ClientID             string            `json:"client_id"`
    RequestIP            string            `json:"request_ip"`
}
```

**Invariants**:
- `SequenceNumber` is monotonically increasing, gapless
- `Hash` is SHA-256 of (SequenceNumber + EventType + Payload + Timestamp)
- `TenantID` and `Namespace` enforce isolation
- `Timestamp` is server-assigned (not client-provided)

### Document (Derived from Events)

```typescript
interface Document {
  document_id: string;
  collection: string;
  content: any;
  created_at: string;
  updated_at?: string;
  sequence_number: uint64;
  timestamp: string;
  tenant_id: string;
  namespace: string;
}
```

**Derivation Rules**:
- Created from `document.created` events
- Updated from `document.updated` events
- Deleted from `document.deleted` events (soft delete)
- Always rebuildable from WAL replay

### Metrics (Real-time Aggregation)

```typescript
interface Metrics {
  // Throughput
  eventsPerSecond: number;        // Calculated from event timestamps
  
  // Latency (from LatencyTracker)
  appendLatencyP50: number;       // Milliseconds
  appendLatencyP99: number;       // Milliseconds
  readLatencyP50: number;         // Milliseconds
  readLatencyP99: number;         // Milliseconds
  
  // Counts (from ShrikDB)
  totalDocuments: number;         // Count of document.created - document.deleted
  activeStreams: number;          // Count of unique streams
  appendRequests: number;         // Total append requests
  readRequests: number;           // Total read requests
  replayRequests: number;         // Total replay requests
  
  // Storage (from ShrikDB)
  storageUsedBytes: number;       // WAL file size
  
  // Errors
  errorCount: number;             // Total errors
}
```

**Calculation Rules**:
- `eventsPerSecond`: Count events in 5-second sliding window
- Latency percentiles: From LatencyTracker sliding window (1000 samples)
- Document count: Derived from event log (created - deleted)
- Storage: Actual WAL file size from filesystem

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*


### Property 1: All Writes Through WAL

*For any* write operation (document create/update/delete, stream publish, tenant create), the system SHALL route it through the ShrikDB AppendEvent API, resulting in a WAL event with a monotonically increasing sequence number.

**Validates: Requirements 1.1, 1.3, 2.1**

### Property 2: No Bypass Paths

*For any* system state change, the system SHALL NOT maintain side databases, shadow state, or bypass paths—all state SHALL be derivable from the WAL.

**Validates: Requirements 1.2, 2.2**

### Property 3: Deterministic Replay

*For any* WAL state, replaying from sequence 0 SHALL produce identical projections (documents, streams, metrics) regardless of how many times replay is executed.

**Validates: Requirements 1.4, 5.1, 5.2, 5.3, 11.2, 19.1, 20.2**

### Property 4: Crash Recovery

*For any* system crash (ShrikDB, Backend, Frontend), restarting SHALL recover all committed events from the WAL with no data loss, and all projections SHALL be rebuildable.

**Validates: Requirements 1.5, 2.5, 10.1, 10.2, 10.3, 10.4, 20.1**

### Property 5: Tenant Isolation

*For any* tenant, events appended SHALL be scoped to that tenant, and cross-tenant access attempts SHALL be rejected with 403 status.

**Validates: Requirements 3.3, 3.4**

### Property 6: Authentication from WAL

*For any* authentication request, credentials SHALL be validated against ShrikDB Core (not local cache), and failures SHALL be logged with correlation IDs.

**Validates: Requirements 3.1, 3.2, 3.5**

### Property 7: Real-Time WebSocket Delivery

*For any* event appended to the WAL, the WebSocket service SHALL broadcast it to connected clients in real-time, and the event SHALL match the WAL event exactly (no mocks or simulations).

**Validates: Requirements 4.1, 4.2, 4.4, 16.3**

### Property 8: WebSocket Reconnection Resume

*For any* WebSocket disconnection, reconnecting SHALL resume event delivery from the last received sequence number with no gaps or duplicates.

**Validates: Requirements 4.4**

### Property 9: No Fake Activity

*For any* idle period (no real events), the system SHALL NOT generate fake events, mock metrics, or synthetic data.

**Validates: Requirements 4.5, 16.1, 16.2, 16.4**

### Property 10: Event Display Completeness

*For any* event displayed in the UI (Event Log Viewer), it SHALL show sequence number, event type, project_id, timestamp, and tenant_id.

**Validates: Requirements 4.3, 6.1, 6.3**

### Property 11: Replay Progress Observability

*For any* replay operation, the system SHALL display real progress (events processed, current sequence) and log errors with failing sequence numbers.

**Validates: Requirements 5.4, 5.5**

### Property 12: Projection Filtering

*For any* query with tenant/project/namespace filters, the system SHALL return only events matching those filters.

**Validates: Requirements 6.5**

### Property 13: Real Metrics Calculation

*For any* metric displayed (throughput, latency, storage), it SHALL be calculated from real measurements (not hardcoded or simulated).

**Validates: Requirements 7.1, 7.2, 7.3, 7.4, 9.1, 9.2, 9.3, 9.4**

### Property 14: Error Observability

*For any* error (auth failure, quota violation, replay error), the system SHALL log it and display it in the Health Panel with correlation IDs and error details.

**Validates: Requirements 8.1, 8.2, 8.3**

### Property 15: Exactly-Once Processing

*For any* event in the WAL, processing it multiple times (e.g., during replay) SHALL affect projections exactly once—duplicate events SHALL be rejected.

**Validates: Requirements 11.1, 11.3, 11.5**

### Property 16: Checkpoint Recovery

*For any* processing interruption, resuming SHALL continue from the last committed checkpoint with no duplicate or lost events.

**Validates: Requirements 11.4**

### Property 17: Backpressure Correctness

*For any* system overload, applying backpressure SHALL slow producers while maintaining data integrity, event ordering, and no crashes.

**Validates: Requirements 12.1, 12.2, 12.5**

### Property 18: Backpressure Release

*For any* backpressure application, releasing it SHALL restore normal throughput and log metrics (queue depth, wait time).

**Validates: Requirements 12.3, 12.4**

### Property 19: Container Orchestration

*For any* Docker container startup, the system SHALL initialize in the correct order (ShrikDB → Backend → Frontend) with health checks, and recover state automatically from the WAL.

**Validates: Requirements 13.2, 13.3, 13.5**

### Property 20: WAL Data Persistence

*For any* container stop/restart, WAL data SHALL persist to volumes and be available after restart.

**Validates: Requirements 13.4**

### Property 21: End-to-End Write Verification

*For any* event appended via the verification script, it SHALL appear in the WAL with a sequence number, and reading it back SHALL return the same event.

**Validates: Requirements 14.2, 14.3**

### Property 22: Verification Performance Reporting

*For any* verification run, performance metrics (events/sec, latency) SHALL be measured from real operations and reported accurately.

**Validates: Requirements 15.4**

### Property 23: Verification Logging

*For any* verification operation, logs SHALL include timestamps and correlation IDs for traceability.

**Validates: Requirements 15.5**

### Property 24: Sequence Monotonicity

*For any* sequence of events appended, sequence numbers SHALL be monotonically increasing with no gaps or duplicates, and verification SHALL confirm this.

**Validates: Requirements 18.1, 18.2, 18.3, 18.4, 18.5, 10.5, 14.5**

### Property 25: State Consistency After Replay

*For any* projection (documents, streams, metrics), querying before and after replay SHALL return identical results.

**Validates: Requirements 19.2, 19.3, 19.4, 19.5**

### Property 26: Complete Replay Coverage

*For any* replay operation, all events from sequence 0 to the latest SHALL be processed, and verification SHALL confirm all appended events are present.

**Validates: Requirements 20.3, 20.4, 20.5**

## Error Handling

### Error Categories

1. **Authentication Errors**:
   - Invalid credentials → 401 Unauthorized
   - Missing credentials → 400 Bad Request
   - Expired session → 401 Unauthorized
   - Cross-tenant access → 403 Forbidden

2. **Validation Errors**:
   - Missing required fields → 400 Bad Request
   - Invalid tenant/namespace format → 400 Bad Request
   - Invalid event type → 400 Bad Request

3. **Quota Errors**:
   - Rate limit exceeded → 429 Too Many Requests
   - Storage quota exceeded → 507 Insufficient Storage
   - Namespace quota exceeded → 429 Too Many Requests

4. **System Errors**:
   - ShrikDB unavailable → 503 Service Unavailable
   - WAL write failure → 500 Internal Server Error
   - Replay failure → 500 Internal Server Error

5. **Data Errors**:
   - Sequence gap detected → Log error, halt replay
   - Hash mismatch → Log error, halt replay
   - Duplicate event → Reject with error

### Error Response Format

```json
{
  "success": false,
  "error": "Human-readable error message",
  "code": "ERROR_CODE",
  "correlation_id": "uuid",
  "timestamp": "ISO8601",
  "details": {
    "field": "Additional context"
  }
}
```

### Error Logging

All errors SHALL be logged with:
- Timestamp (ISO8601)
- Level (error, warn, info)
- Component (shrikdb-core, backend, frontend)
- Message (human-readable)
- Correlation ID (for tracing)
- Error details (stack trace, context)

### Error Recovery

1. **Transient Errors** (network, timeout):
   - Retry with exponential backoff
   - Max 5 retries
   - Initial delay: 1s, max delay: 30s

2. **Permanent Errors** (auth, validation):
   - No retry
   - Return error to client immediately

3. **System Errors** (crash, corruption):
   - Trigger replay from sequence 0
   - Verify integrity
   - Resume normal operations

## Testing Strategy

### Dual Testing Approach

The system requires both unit tests and property-based tests:

**Unit Tests**:
- Specific examples (e.g., "create document with valid data")
- Edge cases (e.g., "empty event payload")
- Error conditions (e.g., "invalid credentials")
- Integration points (e.g., "backend calls ShrikDB")

**Property-Based Tests**:
- Universal properties (e.g., "all writes go through WAL")
- Comprehensive input coverage through randomization
- Minimum 100 iterations per property test
- Each property test references its design document property

### Property-Based Testing Configuration

**Framework**: Use `fast-check` for TypeScript/JavaScript, `testing/quick` for Go

**Test Structure**:
```typescript
// Example property test
test('Property 1: All Writes Through WAL', async () => {
  // Feature: shrikdb-phase-4b-production-hardening, Property 1
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        collection: fc.string(),
        content: fc.object(),
      }),
      async (doc) => {
        // Append document
        const response = await backend.createDocument(doc);
        
        // Verify WAL event exists
        const events = await shrikdb.readEvents(0);
        const walEvent = events.find(e => e.event_id === response.event_id);
        
        expect(walEvent).toBeDefined();
        expect(walEvent.sequence_number).toBeGreaterThan(0);
      }
    ),
    { numRuns: 100 }
  );
});
```

### Test Coverage Requirements

1. **All 26 Properties**: Each property MUST have a property-based test
2. **Critical Paths**: Unit tests for authentication, WAL append, replay
3. **Error Conditions**: Unit tests for all error categories
4. **Integration**: End-to-end tests for Frontend → Backend → ShrikDB
5. **Performance**: Benchmark tests for throughput and latency

### Verification Script

The verification script SHALL:
1. Create real projects and accounts
2. Append events via API
3. Read events and verify they match
4. Subscribe to WebSocket and verify real-time delivery
5. Trigger replay from sequence 0
6. Verify sequence monotonicity (no gaps/duplicates)
7. Verify state consistency (before/after replay)
8. Measure performance (throughput, latency)
9. Output results in JSON format

**Example Verification Output**:
```json
{
  "timestamp": "2026-01-14T12:00:00Z",
  "overall_status": "passed",
  "tests": [
    {
      "name": "Write Path",
      "status": "passed",
      "events_appended": 1000,
      "duration_ms": 523
    },
    {
      "name": "Read Path",
      "status": "passed",
      "events_read": 1000,
      "duration_ms": 145
    },
    {
      "name": "Replay",
      "status": "passed",
      "events_processed": 1000,
      "duration_ms": 892,
      "sequence_gaps": 0,
      "state_consistent": true
    },
    {
      "name": "WebSocket Delivery",
      "status": "passed",
      "events_delivered": 1000,
      "avg_latency_ms": 12
    }
  ],
  "performance": {
    "append_throughput_eps": 1912,
    "read_throughput_eps": 6896,
    "replay_throughput_eps": 1121,
    "append_latency_p50_ms": 0.5,
    "append_latency_p99_ms": 2.1,
    "read_latency_p50_ms": 0.2,
    "read_latency_p99_ms": 0.8
  }
}
```

## Deployment

### Docker Compose Configuration

```yaml
version: '3.8'

services:
  shrikdb:
    build:
      context: ./shrikdb
      dockerfile: Dockerfile
    ports:
      - "8080:8080"
    volumes:
      - ./data:/app/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 10s
      timeout: 5s
      retries: 5
    environment:
      - DATA_DIR=/app/data
      - LOG_LEVEL=info

  backend:
    build:
      context: .
      dockerfile: Dockerfile.backend
    ports:
      - "3001:3001"
      - "3002:3002"
    depends_on:
      shrikdb:
        condition: service_healthy
    environment:
      - SHRIKDB_URL=http://shrikdb:8080
      - PORT=3001
      - WEBSOCKET_PORT=3002
      - CORS_ORIGIN=http://localhost:3000
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3001/health"]
      interval: 10s
      timeout: 5s
      retries: 5

  frontend:
    build:
      context: .
      dockerfile: Dockerfile.frontend
    ports:
      - "3000:80"
    depends_on:
      backend:
        condition: service_healthy
    environment:
      - REACT_APP_API_URL=http://localhost:3001
      - REACT_APP_WS_URL=ws://localhost:3002

volumes:
  data:
    driver: local
```

### Startup Order

1. **ShrikDB Core** starts first
   - Initializes WAL
   - Loads existing projects
   - Starts HTTP server on port 8080
   - Reports healthy

2. **Backend** starts after ShrikDB is healthy
   - Connects to ShrikDB
   - Starts HTTP server on port 3001
   - Starts WebSocket server on port 3002
   - Reports healthy

3. **Frontend** starts after Backend is healthy
   - Serves static files via nginx
   - Proxies API requests to Backend
   - Proxies WebSocket requests to Backend

### Health Checks

Each service exposes a `/health` endpoint:

```json
{
  "status": "healthy",
  "service": "shrikdb-core",
  "timestamp": "2026-01-14T12:00:00Z",
  "version": "4.0.0",
  "uptime_seconds": 3600
}
```

### Data Persistence

- **WAL files**: Persisted to `./data/projects/{project_id}/events.wal`
- **Credentials**: Persisted to `./data/credentials.json`
- **Projections**: Rebuildable from WAL (not persisted)

### Environment Variables

**ShrikDB Core**:
- `DATA_DIR`: Data directory path (default: `/app/data`)
- `LOG_LEVEL`: Logging level (default: `info`)
- `PORT`: HTTP server port (default: `8080`)

**Backend**:
- `SHRIKDB_URL`: ShrikDB Core URL (default: `http://localhost:8080`)
- `PORT`: HTTP server port (default: `3001`)
- `WEBSOCKET_PORT`: WebSocket server port (default: `3002`)
- `CORS_ORIGIN`: CORS origin (default: `http://localhost:3000`)

**Frontend**:
- `REACT_APP_API_URL`: Backend API URL (default: `http://localhost:3001`)
- `REACT_APP_WS_URL`: WebSocket URL (default: `ws://localhost:3002`)

## Performance Considerations

### Throughput Targets

- **Append**: 10,000+ events/sec
- **Read**: 50,000+ events/sec
- **Replay**: 5,000+ events/sec
- **WebSocket Delivery**: <50ms latency

### Optimization Strategies

1. **WAL Batching**:
   - Batch multiple appends into single fsync
   - Reduces disk I/O overhead
   - Maintains sequence ordering

2. **Projection Caching**:
   - Cache recent projections in memory
   - Invalidate on new events
   - Reduces replay frequency

3. **WebSocket Batching**:
   - Batch multiple events into single message
   - Reduces network overhead
   - Maintains event ordering

4. **Latency Tracking**:
   - Use sliding window (1000 samples)
   - Calculate percentiles efficiently
   - Avoid full sort on every request

### Bottleneck Identification

Monitor these metrics to identify bottlenecks:

1. **Append Latency**: If high, check disk I/O
2. **Read Latency**: If high, check projection cache
3. **WebSocket Latency**: If high, check network or batching
4. **Replay Speed**: If low, check disk I/O or projection logic

## Security Considerations

### Authentication

- All API requests require `X-Client-ID` and `X-Client-Key` headers
- Credentials validated against ShrikDB Core (not local cache)
- Sessions expire after 24 hours
- Failed auth attempts logged with correlation IDs

### Authorization

- Tenant isolation enforced at WAL append time
- Cross-tenant access rejected with 403
- Project-based access control
- Namespace-based access control

### Data Protection

- WAL files protected by filesystem permissions
- No sensitive data in logs (credentials redacted)
- HTTPS recommended for production (not enforced in dev)

### Audit Trail

- All events include `client_id` and `request_ip`
- All errors logged with correlation IDs
- Security violations logged separately
- Audit log rebuildable from WAL

## Monitoring and Observability

### Metrics Exposed

**ShrikDB Core** (`/metrics`):
```
events_appended_total
events_read_total
wal_bytes_written_total
wal_syncs_performed_total
api_append_requests_total
api_read_requests_total
api_replay_requests_total
```

**Backend** (aggregated):
```
append_latency_p50_ms
append_latency_p99_ms
read_latency_p50_ms
read_latency_p99_ms
error_count_total
auth_failures_total
quota_violations_total
```

### Log Format

Structured JSON logs:
```json
{
  "timestamp": "2026-01-14T12:00:00Z",
  "level": "info",
  "service": "backend",
  "component": "api-gateway",
  "message": "Request received",
  "correlation_id": "uuid",
  "data": {
    "method": "POST",
    "path": "/api/documents",
    "client_id": "client-123"
  }
}
```

### WebSocket Log Streaming

Real-time logs streamed to connected clients:
```json
{
  "type": "log",
  "timestamp": "2026-01-14T12:00:00Z",
  "level": "info",
  "service": "shrikdb-core",
  "component": "wal",
  "message": "Event appended",
  "data": {
    "sequence": 12345,
    "event_type": "document.created"
  }
}
```

### Alerting

Monitor these conditions:

1. **High Error Rate**: >1% of requests failing
2. **High Latency**: P99 >100ms for appends
3. **Sequence Gaps**: Any gaps detected during verification
4. **Service Unhealthy**: Health check failures
5. **Quota Violations**: >10 violations/minute

## Migration and Rollback

### Migration Strategy

Phase 4B is a hardening phase, not a migration. Existing Phase 3 systems can upgrade by:

1. Ensuring all writes go through WAL (no bypass paths)
2. Removing all mock data from frontend
3. Adding diagnostic UI components
4. Running verification script to confirm correctness

### Rollback Strategy

If Phase 4B introduces issues:

1. Revert to Phase 3 code
2. WAL data remains intact (backward compatible)
3. Projections rebuild automatically
4. No data loss (WAL is append-only)

## Future Enhancements

Phase 4B focuses on production hardening. Future phases may add:

1. **Horizontal Scaling**: Multiple ShrikDB instances with sharding
2. **Replication**: Multi-region WAL replication
3. **Compression**: WAL compression for storage efficiency
4. **Advanced Queries**: Secondary indexes on projections
5. **Streaming Aggregations**: Real-time analytics on event streams

These enhancements will build on the solid foundation of Phase 4B's production-grade architecture.
