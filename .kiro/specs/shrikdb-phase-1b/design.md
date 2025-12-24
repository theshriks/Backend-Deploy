# Design Document

## Overview

ShrikDB Phase 1B implements a production-grade document database as a pure projection over the existing event log from Phase 1A. This phase transforms ShrikDB from an event-only system into a full-featured document database while maintaining the event log as the single source of truth. The document projection is completely disposable and can be rebuilt from events at any time.

The system provides a MongoDB-like interface for document operations while ensuring all changes flow through the event log first. The projection engine processes DocumentCreated, DocumentUpdated, and DocumentDeleted events to maintain current document state, enabling fast queries while preserving event sourcing benefits.

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
                            │ (Phase 1A)  │   │ (Phase 1A)  │
                            └─────────────┘   └─────────────┘
                                                     │
                                                     ▼
                                            ┌─────────────┐
                                            │ Projection  │
                                            │ Engine      │
                                            │ (NEW)       │
                                            └─────────────┘
                                                     │
                                    ┌────────────────┼────────────────┐
                                    ▼                ▼                ▼
                            ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
                            │ Document    │ │ Query       │ │ Replay      │
                            │ Store       │ │ Engine      │ │ Engine      │
                            │ (NEW)       │ │ (NEW)       │ │ (Enhanced)  │
                            └─────────────┘ └─────────────┘ └─────────────┘
                                                     │
                                                     ▼
                                            ┌─────────────┐
                                            │ File System │
                                            │ (WAL Files) │
                                            └─────────────┘
```

### Component Interaction Flow

1. **Write Path**: Frontend → API → Event Log → Projection Engine → Document Store
2. **Read Path**: Frontend → API → Query Engine → Document Store
3. **Replay Path**: Replay Engine → Event Log → Projection Engine → Document Store

### Key Design Principles

- **Event Log as Truth**: Documents are projections, events are reality
- **Write-Through Pattern**: Events first, projections second
- **Disposable Projections**: Document store can be deleted and rebuilt
- **Separation of Concerns**: Clear boundaries between event storage and document queries
- **Backward Compatibility**: Phase 1A APIs remain unchanged

## Components and Interfaces

### Document Projection Engine (`pkg/projection`)

**Purpose**: Processes events to maintain current document state.

**Key Interfaces**:
```go
type Engine interface {
    ProcessEvent(ctx context.Context, event *event.Event) error
    RebuildFromEvents(ctx context.Context, projectID string, events []*event.Event) error
    GetMetrics() *Metrics
    Close() error
}

type EventHandler interface {
    HandleDocumentCreated(ctx context.Context, event *event.Event) error
    HandleDocumentUpdated(ctx context.Context, event *event.Event) error
    HandleDocumentDeleted(ctx context.Context, event *event.Event) error
}
```

**Responsibilities**:
- Process DocumentCreated, DocumentUpdated, DocumentDeleted events
- Maintain document state in the document store
- Handle projection failures gracefully (events persist even if projection fails)
- Provide metrics on projection lag and processing speed
- Support full rebuild from event replay

### Document Store (`pkg/docstore`)

**Purpose**: Provides fast storage and retrieval of projected document state.

**Key Interfaces**:
```go
type Store interface {
    CreateDocument(ctx context.Context, doc *Document) error
    UpdateDocument(ctx context.Context, docID string, updates map[string]interface{}) error
    DeleteDocument(ctx context.Context, docID string) error
    GetDocument(ctx context.Context, docID string) (*Document, error)
    FindDocuments(ctx context.Context, query *Query) (*QueryResult, error)
    Clear(ctx context.Context, projectID string) error
    GetStats(ctx context.Context, projectID string) (*StoreStats, error)
}

type Document struct {
    ID         string                 `json:"id"`
    ProjectID  string                 `json:"project_id"`
    Collection string                 `json:"collection"`
    Content    map[string]interface{} `json:"content"`
    CreatedAt  time.Time             `json:"created_at"`
    UpdatedAt  time.Time             `json:"updated_at"`
    Version    uint64                `json:"version"`
}
```

**Responsibilities**:
- Store document state separately from event log
- Provide fast document retrieval by ID
- Support simple field-based queries
- Handle document versioning for conflict detection
- Implement pagination for large result sets
- Support complete store clearing for rebuild scenarios

### Query Engine (`pkg/query`)

**Purpose**: Processes document queries against the projection.

**Key Interfaces**:
```go
type Engine interface {
    FindByID(ctx context.Context, projectID, docID string) (*Document, error)
    FindByFields(ctx context.Context, projectID string, filters map[string]interface{}) (*QueryResult, error)
    FindInCollection(ctx context.Context, projectID, collection string, opts *QueryOptions) (*QueryResult, error)
    CountDocuments(ctx context.Context, projectID string, filters map[string]interface{}) (int64, error)
}

type QueryOptions struct {
    Filters    map[string]interface{} `json:"filters,omitempty"`
    Limit      int                    `json:"limit,omitempty"`
    Offset     int                    `json:"offset,omitempty"`
    SortBy     string                 `json:"sort_by,omitempty"`
    SortOrder  string                 `json:"sort_order,omitempty"` // "asc" or "desc"
}

type QueryResult struct {
    Documents  []*Document `json:"documents"`
    Total      int64       `json:"total"`
    Limit      int         `json:"limit"`
    Offset     int         `json:"offset"`
    HasMore    bool        `json:"has_more"`
}
```

**Responsibilities**:
- Execute queries against document projections only
- Support pagination with limit/offset
- Provide basic filtering by field values
- Return structured results with metadata
- Never query the event log directly

### Enhanced API Service (`pkg/api` - Extended)

**Purpose**: Extends Phase 1A API with document operations.

**New Endpoints**:
```go
// Document write operations (create events)
CreateDocument(ctx context.Context, req *CreateDocumentRequest) (*CreateDocumentResponse, error)
UpdateDocument(ctx context.Context, req *UpdateDocumentRequest) (*UpdateDocumentResponse, error)
DeleteDocument(ctx context.Context, req *DeleteDocumentRequest) (*DeleteDocumentResponse, error)

// Document read operations (query projections)
GetDocument(ctx context.Context, req *GetDocumentRequest) (*GetDocumentResponse, error)
FindDocuments(ctx context.Context, req *FindDocumentsRequest) (*FindDocumentsResponse, error)
ListCollections(ctx context.Context, req *ListCollectionsRequest) (*ListCollectionsResponse, error)

// Projection management
RebuildProjection(ctx context.Context, req *RebuildProjectionRequest) (*RebuildProjectionResponse, error)
GetProjectionStatus(ctx context.Context, req *ProjectionStatusRequest) (*ProjectionStatusResponse, error)
```

**Responsibilities**:
- Route write operations through event creation
- Route read operations through query engine
- Maintain backward compatibility with Phase 1A APIs
- Provide projection management endpoints
- Expose document-specific metrics

### Enhanced Replay Engine (`pkg/replay` - Extended)

**Purpose**: Extends Phase 1A replay to rebuild document projections.

**Enhanced Interfaces**:
```go
type Engine interface {
    // Phase 1A methods (unchanged)
    ReplayFrom(ctx context.Context, projectID string, fromSequence uint64, handler EventHandler) (*Progress, error)
    VerifyIntegrity(ctx context.Context, projectID string) (*Progress, error)
    
    // Phase 1B additions
    RebuildProjections(ctx context.Context, projectID string) (*Progress, error)
    VerifyProjectionConsistency(ctx context.Context, projectID string) (*ConsistencyReport, error)
}

type ConsistencyReport struct {
    ProjectID           string    `json:"project_id"`
    EventsProcessed     uint64    `json:"events_processed"`
    DocumentsRebuilt    int64     `json:"documents_rebuilt"`
    InconsistenciesFound int      `json:"inconsistencies_found"`
    RebuildDuration     time.Duration `json:"rebuild_duration"`
    Timestamp          time.Time `json:"timestamp"`
}
```

**Responsibilities**:
- Rebuild document projections from complete event history
- Verify projection consistency against events
- Provide detailed progress reporting
- Handle large-scale rebuilds efficiently
- Support verification without rebuilding

## Data Models

### Event Types for Documents

**DocumentCreated Event**:
```json
{
  "event_type": "document.created",
  "payload": {
    "document_id": "doc_123",
    "collection": "users",
    "content": {
      "name": "John Doe",
      "email": "john@example.com",
      "age": 30
    }
  }
}
```

**DocumentUpdated Event**:
```json
{
  "event_type": "document.updated", 
  "payload": {
    "document_id": "doc_123",
    "updates": {
      "age": 31,
      "last_login": "2024-01-15T10:30:00Z"
    },
    "version": 2
  }
}
```

**DocumentDeleted Event**:
```json
{
  "event_type": "document.deleted",
  "payload": {
    "document_id": "doc_123",
    "collection": "users"
  }
}
```

### Document Projection Model

```go
type Document struct {
    ID         string                 `json:"id" bson:"_id"`
    ProjectID  string                 `json:"project_id" bson:"project_id"`
    Collection string                 `json:"collection" bson:"collection"`
    Content    map[string]interface{} `json:"content" bson:"content"`
    CreatedAt  time.Time             `json:"created_at" bson:"created_at"`
    UpdatedAt  time.Time             `json:"updated_at" bson:"updated_at"`
    Version    uint64                `json:"version" bson:"version"`
    EventID    string                `json:"event_id" bson:"event_id"` // Last event that modified this doc
}
```

### Query Models

```go
type Query struct {
    ProjectID  string                 `json:"project_id"`
    Collection string                 `json:"collection,omitempty"`
    Filters    map[string]interface{} `json:"filters,omitempty"`
    Limit      int                    `json:"limit,omitempty"`
    Offset     int                    `json:"offset,omitempty"`
    SortBy     string                 `json:"sort_by,omitempty"`
    SortOrder  string                 `json:"sort_order,omitempty"`
}

type QueryResult struct {
    Documents []*Document `json:"documents"`
    Total     int64       `json:"total"`
    Limit     int         `json:"limit"`
    Offset    int         `json:"offset"`
    HasMore   bool        `json:"has_more"`
}
```

### Metrics Models

```go
type ProjectionMetrics struct {
    DocumentsCount     int64         `json:"documents_count"`
    ProjectionLag      time.Duration `json:"projection_lag"`
    EventsProcessed    uint64        `json:"events_processed"`
    ProcessingRate     float64       `json:"processing_rate"` // events per second
    LastProcessedEvent string        `json:"last_processed_event"`
    RebuildTime        time.Duration `json:"last_rebuild_time"`
}
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

Now I need to analyze the acceptance criteria for testability before writing the correctness properties.
### Event-First Write Properties

**Property 1: Document creation event ordering**
*For any* document creation request, the DocumentCreated event should be successfully appended to the event log before the document appears in the projection
**Validates: Requirements 1.1**

**Property 2: Document update event ordering**
*For any* document update request, the DocumentUpdated event should be successfully appended to the event log before the projection reflects the changes
**Validates: Requirements 1.2**

**Property 3: Document deletion event ordering**
*For any* document deletion request, the DocumentDeleted event should be successfully appended to the event log before the document is removed from the projection
**Validates: Requirements 1.3**

**Property 4: Projection consistency with events**
*For any* successfully appended document event, the document projection should be updated to reflect the change described in the event
**Validates: Requirements 1.4**

**Property 5: Event persistence despite projection failures**
*For any* document event that is successfully appended to the log, the event should remain in the log even if the projection update fails
**Validates: Requirements 1.5**

### Query Engine Properties

**Property 6: Document ID query correctness**
*For any* document that exists in the projection, querying by its ID should return the current projected state of that document
**Validates: Requirements 2.1**

**Property 7: Field-based query completeness**
*For any* field-based query, all documents in the projection that match the specified field values should be included in the results
**Validates: Requirements 2.2**

**Property 8: Pagination correctness**
*For any* paginated query request, the returned results should contain exactly the requested page of documents with accurate pagination metadata
**Validates: Requirements 2.3**

### Replay and Rebuild Properties

**Property 9: Chronological event processing**
*For any* replay operation, DocumentCreated, DocumentUpdated, and DocumentDeleted events should be processed in chronological order by sequence number
**Validates: Requirements 3.1**

**Property 10: Document creation replay**
*For any* DocumentCreated event processed during replay, a corresponding document should be created in the projection with the event's payload content
**Validates: Requirements 3.2**

**Property 11: Document update replay**
*For any* DocumentUpdated event processed during replay, the corresponding document in the projection should be modified according to the event's update payload
**Validates: Requirements 3.3**

**Property 12: Document deletion replay**
*For any* DocumentDeleted event processed during replay, the corresponding document should be removed from the projection
**Validates: Requirements 3.4**

**Property 13: Deterministic replay results**
*For any* project, multiple replay operations should produce identical document projection state regardless of the initial projection state
**Validates: Requirements 3.5**

### Observability Properties

**Property 14: Documents count metric availability**
*For any* running system, the documents_count metric should be exposed and should accurately reflect the total number of documents in the projection
**Validates: Requirements 4.1**

**Property 15: Projection lag metric tracking**
*For any* event processing operation, the projection_lag metric should accurately reflect the time delay between event creation and projection update
**Validates: Requirements 4.2**

**Property 16: Replay duration metric reporting**
*For any* replay operation, the replay_rebuild_time metric should accurately reflect the total duration of the rebuild process
**Validates: Requirements 4.3**

**Property 17: Projection failure logging**
*For any* projection update failure, detailed error information should be logged including the event ID, error type, and failure context
**Validates: Requirements 4.4**

**Property 18: Replay mismatch logging**
*For any* replay operation that produces different results from expected, specific mismatch details should be logged for investigation
**Validates: Requirements 4.5**

### Frontend Integration Properties

**Property 19: Frontend write API usage**
*For any* document creation, update, or deletion initiated by the frontend, the operation should use event API endpoints rather than direct document manipulation
**Validates: Requirements 5.1**

**Property 20: Frontend read API usage**
*For any* document query initiated by the frontend, the operation should use projection API endpoints rather than event log queries
**Validates: Requirements 5.2**

**Property 21: Frontend pagination support**
*For any* document list display in the frontend, pagination should be implemented using projection query pagination features
**Validates: Requirements 5.3**

**Property 22: API availability during rebuilds**
*For any* projection rebuild operation, the API should remain available and serve consistent responses throughout the rebuild process
**Validates: Requirements 5.4**

### Verification Properties

**Property 23: Baseline state capture**
*For any* verification run, the current document projection state should be completely captured as a baseline before any rebuild operations
**Validates: Requirements 6.1**

**Property 24: Complete store clearing**
*For any* verification operation, the document store deletion should remove all projected document data for the specified project
**Validates: Requirements 6.2**

**Property 25: Complete event replay**
*For any* verification rebuild, all document events from the complete event log should be processed to reconstruct the projection
**Validates: Requirements 6.3**

**Property 26: State comparison accuracy**
*For any* verification completion, the comparison between rebuilt state and original baseline should detect any differences with complete accuracy
**Validates: Requirements 6.4**

**Property 27: Verification result reporting**
*For any* verification operation, concrete results should be output showing either success or specific details of any mismatches found
**Validates: Requirements 6.5**

### MongoDB-like Interface Properties

**Property 28: Unique document ID assignment**
*For any* document creation operation, the system should assign a globally unique identifier and return it to the client
**Validates: Requirements 7.1**

**Property 29: Partial update correctness**
*For any* document update operation, only the fields specified in the update payload should be modified while other fields remain unchanged
**Validates: Requirements 7.2**

**Property 30: Query functionality completeness**
*For any* document query, the system should support field selection and basic filtering operations as specified in the query parameters
**Validates: Requirements 7.3**

**Property 31: Immediate delete consistency**
*For any* document deletion, the deleted document should not appear in any subsequent query results after the projection update completes
**Validates: Requirements 7.4**

**Property 32: Concurrent operation consistency**
*For any* set of concurrent document operations, the final system state should be consistent and deterministic based on event ordering
**Validates: Requirements 7.5**

## Error Handling

### Projection Engine Error Handling

**Event Processing Failures**: When projection updates fail:
- Log detailed error information with event ID and failure context
- Preserve the original event in the log (never delete events due to projection failures)
- Continue processing subsequent events to maintain system availability
- Expose projection health metrics to monitor failure rates

**Replay Failures**: When replay operations encounter errors:
- Halt replay at the point of failure and report the problematic event
- Log complete context including event sequence number and error details
- Provide recovery options (skip corrupted events, manual intervention)
- Maintain partial projection state for debugging

**Store Corruption**: When document store corruption is detected:
- Immediately switch to read-only mode to prevent further corruption
- Log corruption details and affected document ranges
- Trigger automatic rebuild from event log if corruption is localized
- Provide manual recovery procedures for severe corruption

### Query Engine Error Handling

**Invalid Queries**: For malformed or invalid query requests:
- Return structured error responses with specific validation failures
- Log query patterns that frequently fail for system improvement
- Provide query syntax guidance in error messages
- Maintain query performance metrics even for failed queries

**Resource Exhaustion**: When queries exceed system limits:
- Implement query timeouts with configurable limits
- Return partial results with continuation tokens for large datasets
- Log resource usage patterns for capacity planning
- Provide query optimization suggestions in responses

**Projection Unavailability**: When document store is temporarily unavailable:
- Return appropriate service unavailable responses
- Implement exponential backoff for retry logic
- Maintain separate health checks for projection vs event log
- Provide estimated recovery time in error responses

### API Error Handling

**Authentication Failures**: For invalid or expired credentials:
- Return 401 Unauthorized with clear error messages
- Log authentication attempts for security monitoring
- Implement rate limiting for failed authentication attempts
- Provide credential refresh guidance in responses

**Authorization Failures**: For project access violations:
- Return 403 Forbidden with project-specific error details
- Log authorization violations for audit purposes
- Validate project access at both event and projection levels
- Maintain consistent authorization across all API endpoints

**Request Validation**: For invalid request payloads:
- Return 400 Bad Request with detailed validation errors
- Validate document schemas against configurable rules
- Provide schema documentation in error responses
- Log validation patterns for schema evolution

## Testing Strategy

### Dual Testing Approach

The system employs both unit testing and property-based testing for comprehensive coverage:

- **Unit tests** verify specific examples, edge cases, and error conditions
- **Property tests** verify universal properties that should hold across all inputs
- Together they provide comprehensive coverage: unit tests catch concrete bugs, property tests verify general correctness

### Property-Based Testing

**Library**: Go's `testing/quick` package with custom generators for document operations and event sequences
**Configuration**: Each property-based test runs a minimum of 100 iterations to ensure thorough coverage
**Tagging**: Each property-based test includes a comment explicitly referencing the correctness property from the design document

**Example Property Test Format**:
```go
// **Feature: shrikdb-phase-1b, Property 13: Deterministic replay results**
func TestDeterministicReplayResults(t *testing.T) {
    quick.Check(func(events []DocumentEvent) bool {
        // Test implementation
    }, &quick.Config{MaxCount: 100})
}
```

**Custom Generators**:
- Document content generators for various data types and structures
- Event sequence generators that create realistic document operation patterns
- Query generators that test various filtering and pagination scenarios
- Concurrent operation generators for testing race conditions

### Unit Testing

**Coverage Areas**:
- Document CRUD operations with specific payloads
- Event processing for each document event type
- Query engine functionality with known datasets
- Projection rebuild scenarios with controlled event sequences
- Error handling for specific failure modes
- API request/response handling for document operations

**Integration Testing**:
- End-to-end document workflows from frontend to projection
- Replay and rebuild operations with real event data
- Concurrent access patterns with multiple clients
- Performance testing under various load conditions

### Performance Testing

**Benchmarks**:
- Document write throughput (documents per second)
- Query response times for various query types
- Projection rebuild speed (events processed per second)
- Memory usage during large-scale operations
- Concurrent operation performance under load

### Verification Testing

**Automated Verification**:
- Scheduled projection consistency checks
- Automated rebuild testing with production-like data
- Cross-validation between event log and projection state
- Performance regression testing for query operations

## Production Configuration

### Document Store Configuration

**Storage Backend**:
```bash
SHRIKDB_DOCSTORE_TYPE=embedded  # embedded, mongodb, postgresql
SHRIKDB_DOCSTORE_PATH=/var/lib/shrikdb/documents
SHRIKDB_DOCSTORE_MAX_SIZE=10GB
SHRIKDB_DOCSTORE_CACHE_SIZE=1GB
```

**Performance Tuning**:
```bash
SHRIKDB_PROJECTION_BATCH_SIZE=1000
SHRIKDB_PROJECTION_FLUSH_INTERVAL=1s
SHRIKDB_QUERY_TIMEOUT=30s
SHRIKDB_MAX_QUERY_RESULTS=10000
```

### Projection Engine Configuration

**Processing Configuration**:
```bash
SHRIKDB_PROJECTION_WORKERS=4
SHRIKDB_PROJECTION_BUFFER_SIZE=10000
SHRIKDB_PROJECTION_RETRY_ATTEMPTS=3
SHRIKDB_PROJECTION_RETRY_DELAY=1s
```

**Monitoring Configuration**:
```bash
SHRIKDB_METRICS_INTERVAL=10s
SHRIKDB_HEALTH_CHECK_INTERVAL=5s
SHRIKDB_LOG_PROJECTION_ERRORS=true
SHRIKDB_LOG_SLOW_QUERIES=true
```

### Backup and Recovery

**Projection Backup**:
- Document store snapshots with point-in-time consistency
- Automated backup scheduling with configurable retention
- Incremental backup support for large document stores
- Cross-region backup replication for disaster recovery

**Recovery Procedures**:
1. **Projection Corruption**: Delete document store and rebuild from events
2. **Partial Data Loss**: Replay events from last known good sequence number
3. **Complete System Recovery**: Restore event log and rebuild all projections
4. **Performance Degradation**: Rebuild projections with optimized settings

### Scaling Considerations

**Horizontal Scaling** (Future Phases):
- Projection sharding by project ID or document collection
- Read replica support for query load distribution
- Event processing parallelization across multiple nodes
- Distributed query coordination for cross-shard operations

**Vertical Scaling**:
- Memory allocation for document caching and query buffers
- CPU allocation for projection processing and query execution
- Storage allocation for document store and temporary query results
- Network bandwidth for API traffic and replication

This design provides a comprehensive foundation for implementing ShrikDB Phase 1B as a production-ready document database built on event sourcing principles, with strong consistency guarantees, comprehensive observability, and robust error handling while maintaining the disposable projection architecture.