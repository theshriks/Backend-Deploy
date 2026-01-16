# Design Document: ShrikDB Phase 3 Production Completion

## Overview

This design extends ShrikDB to achieve true production-level distributed systems capabilities while maintaining the event-sourced architecture and WAL as the single source of truth. Phase 3 builds upon the existing multi-tenant foundation to add horizontal scaling, backpressure control, cross-node coordination, and operational tooling.

The design maintains strict adherence to the foundational principles:
- WAL remains the only source of truth
- All coordination is event-sourced and recoverable
- No external dependencies for consensus
- Everything must be verifiable and deterministic

## Architecture

### Current State (Phase 1A + Multi-Tenant Extensions)
```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (React)                         │
│              Existing UI + New Operational Panels          │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                    HTTP API Server                          │
│         Authentication + Rate Limiting + CORS              │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                    API Service Layer                        │
│    Multi-Tenant Operations + Access Control + Metrics      │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                    Write-Ahead Log (WAL)                    │
│     Single Source of Truth + Multi-Tenant Events          │
└─────────────────────────────────────────────────────────────┘
```

### Phase 3 Target Architecture
```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (React)                         │
│   Existing UI + Worker Status + Backpressure + Metrics     │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                Load Balancer / API Gateway                  │
│              Route to Available API Instances               │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                Multiple API Server Instances                │
│         Stateless + Backpressure + Coordination            │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                  Coordination Layer                         │
│        Event-Sourced Leader Election + Partitioning        │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                Multiple Worker Processes                    │
│      Deterministic Partitioning + State Projections        │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                    Write-Ahead Log (WAL)                    │
│     Single Source of Truth + Coordination Events           │
└─────────────────────────────────────────────────────────────┘
```

## Components and Interfaces

### 1. Multi-Account Management Extension

**Account Model:**
```go
type Account struct {
    AccountID   string    `json:"account_id"`
    Name        string    `json:"name"`
    Status      string    `json:"status"`
    CreatedAt   time.Time `json:"created_at"`
    Projects    []string  `json:"projects"`
    Users       []string  `json:"users"`
    Quotas      map[string]int64 `json:"quotas"`
}

type Project struct {
    ProjectID   string    `json:"project_id"`
    AccountID   string    `json:"account_id"`
    Name        string    `json:"name"`
    Status      string    `json:"status"`
    CreatedAt   time.Time `json:"created_at"`
    TenantID    string    `json:"tenant_id"`
}
```

**Event Types:**
- `ACCOUNT_CREATED`
- `ACCOUNT_PROJECT_CREATED`
- `ACCOUNT_USER_ADDED`
- `ACCOUNT_QUOTA_UPDATED`

### 2. Horizontal Scaling Worker System

**Worker Architecture:**
```go
type Worker struct {
    WorkerID      string              `json:"worker_id"`
    Status        WorkerStatus        `json:"status"`
    Partitions    []PartitionAssignment `json:"partitions"`
    LastHeartbeat time.Time           `json:"last_heartbeat"`
    Capabilities  []string            `json:"capabilities"`
    LoadMetrics   WorkerLoadMetrics   `json:"load_metrics"`
}

type PartitionAssignment struct {
    PartitionID   string    `json:"partition_id"`
    ProjectID     string    `json:"project_id"`
    TenantID      string    `json:"tenant_id"`
    StartSequence uint64    `json:"start_sequence"`
    EndSequence   uint64    `json:"end_sequence"`
    AssignedAt    time.Time `json:"assigned_at"`
}

type WorkerLoadMetrics struct {
    CPUUsage        float64 `json:"cpu_usage"`
    MemoryUsage     float64 `json:"memory_usage"`
    EventsPerSecond float64 `json:"events_per_second"`
    QueueDepth      int     `json:"queue_depth"`
}
```

**Partitioning Strategy:**
- Deterministic partitioning by `hash(project_id + tenant_id) % num_partitions`
- Each partition assigned to exactly one worker
- Partition reassignment through coordination events
- Idempotent projection updates ensure no duplicate processing

### 3. Backpressure and Load Control

**Backpressure Controller:**
```go
type BackpressureController struct {
    TenantLimits    map[string]TenantLimits `json:"tenant_limits"`
    GlobalLimits    GlobalLimits            `json:"global_limits"`
    CurrentLoad     LoadMetrics             `json:"current_load"`
    BackpressureState map[string]BackpressureStatus `json:"backpressure_state"`
}

type TenantLimits struct {
    EventsPerSecond   int `json:"events_per_second"`
    QueueDepthLimit   int `json:"queue_depth_limit"`
    BurstCapacity     int `json:"burst_capacity"`
}

type BackpressureStatus struct {
    Active        bool      `json:"active"`
    Reason        string    `json:"reason"`
    ActivatedAt   time.Time `json:"activated_at"`
    RetryAfter    time.Duration `json:"retry_after"`
}
```

**Backpressure Triggers:**
- Queue depth exceeds tenant limits
- Global system load exceeds thresholds
- Worker processing lag detected
- Storage I/O saturation

### 4. Event-Sourced Coordination

**Coordination Events:**
```go
// Leader election events
type LeaderElectionStarted struct {
    ElectionID    string    `json:"election_id"`
    Candidates    []string  `json:"candidates"`
    StartedAt     time.Time `json:"started_at"`
}

type LeaderElected struct {
    ElectionID    string    `json:"election_id"`
    LeaderID      string    `json:"leader_id"`
    ElectedAt     time.Time `json:"elected_at"`
    Term          uint64    `json:"term"`
}

// Worker coordination events
type WorkerRegistered struct {
    WorkerID      string            `json:"worker_id"`
    Capabilities  []string          `json:"capabilities"`
    RegisteredAt  time.Time         `json:"registered_at"`
}

type PartitionAssigned struct {
    PartitionID   string    `json:"partition_id"`
    WorkerID      string    `json:"worker_id"`
    AssignedAt    time.Time `json:"assigned_at"`
    PreviousWorker string   `json:"previous_worker"`
}

type WorkerHeartbeat struct {
    WorkerID      string            `json:"worker_id"`
    Timestamp     time.Time         `json:"timestamp"`
    LoadMetrics   WorkerLoadMetrics `json:"load_metrics"`
    Health        string            `json:"health"`
}
```

**Coordination State Machine:**
- Leader election via event sequence consensus
- Partition assignment through leader decisions
- Worker failure detection via missed heartbeats
- Safe handoff protocols for partition transfers

### 5. Load-Based Autoscaling Signals

**Scaling Signal Generator:**
```go
type AutoscalingSignal struct {
    SignalType    string            `json:"signal_type"`
    Severity      string            `json:"severity"`
    Metrics       ScalingMetrics    `json:"metrics"`
    Recommendation string           `json:"recommendation"`
    Timestamp     time.Time         `json:"timestamp"`
}

type ScalingMetrics struct {
    CPUPressure       float64 `json:"cpu_pressure"`
    EventThroughput   float64 `json:"event_throughput"`
    QueueDepth        int     `json:"queue_depth"`
    WorkerUtilization float64 `json:"worker_utilization"`
    ResponseLatency   float64 `json:"response_latency"`
}
```

**Signal Types:**
- `SCALE_UP_WORKERS` - Need more processing capacity
- `SCALE_DOWN_WORKERS` - Excess capacity detected
- `SCALE_UP_API` - API server bottleneck
- `STORAGE_PRESSURE` - I/O capacity limits

### 6. Administrative Tooling

**Admin API Extensions:**
```go
// Worker management
GET /admin/workers
POST /admin/workers/{worker_id}/restart
POST /admin/workers/{worker_id}/drain

// Partition management
GET /admin/partitions
POST /admin/partitions/rebalance
GET /admin/partitions/{partition_id}/status

// Backpressure management
GET /admin/backpressure/status
POST /admin/backpressure/override
DELETE /admin/backpressure/override

// Replay controls
POST /admin/replay/{project_id}/start
GET /admin/replay/{project_id}/status
POST /admin/replay/{project_id}/cancel
```

**Diagnostic Tools:**
- One-command system health check
- Partition assignment visualization
- Event flow tracing
- Performance bottleneck identification

## Data Models

### Account and Project Hierarchy
```json
{
  "account": {
    "account_id": "acc_123",
    "name": "Acme Corp",
    "status": "active",
    "created_at": "2024-01-15T10:30:00Z",
    "projects": ["proj_456", "proj_789"],
    "users": ["user_abc", "user_def"],
    "quotas": {
      "projects_max": 10,
      "users_max": 100,
      "events_per_hour": 1000000
    }
  },
  "project": {
    "project_id": "proj_456",
    "account_id": "acc_123",
    "name": "Production API",
    "status": "active",
    "created_at": "2024-01-15T10:35:00Z",
    "tenant_id": "tenant_456"
  }
}
```

### Worker State
```json
{
  "worker": {
    "worker_id": "worker_001",
    "status": "active",
    "partitions": [
      {
        "partition_id": "part_001",
        "project_id": "proj_456",
        "tenant_id": "tenant_456",
        "start_sequence": 1000,
        "end_sequence": 2000,
        "assigned_at": "2024-01-15T11:00:00Z"
      }
    ],
    "last_heartbeat": "2024-01-15T11:05:00Z",
    "load_metrics": {
      "cpu_usage": 0.65,
      "memory_usage": 0.45,
      "events_per_second": 150.0,
      "queue_depth": 25
    }
  }
}
```

### Coordination State
```json
{
  "coordination": {
    "current_leader": "worker_001",
    "leader_term": 5,
    "election_in_progress": false,
    "partition_assignments": {
      "part_001": "worker_001",
      "part_002": "worker_002",
      "part_003": "worker_001"
    },
    "worker_health": {
      "worker_001": "healthy",
      "worker_002": "healthy",
      "worker_003": "unhealthy"
    }
  }
}
```

Now I'll use the prework tool to analyze the acceptance criteria for correctness properties:

<function_calls>
<invoke name="prework">
<parameter name="featureName">shrikdb-phase-3-production
## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Account Creation Uniqueness
*For any* set of concurrent account creation requests, each account should receive a unique account_id and the creation should be recorded as an event in the WAL
**Validates: Requirements 1.1**

### Property 2: Project ID Uniqueness Within Account Scope
*For any* account, all projects created within that account should have unique project_ids, and projects in different accounts may have the same project_id
**Validates: Requirements 1.2**

### Property 3: Account and Project Isolation Enforcement
*For any* API request attempting to access resources across account boundaries, the system should reject the request with appropriate authorization errors
**Validates: Requirements 1.3, 1.5**

### Property 4: Account Boundary Reconstruction Determinism
*For any* complete WAL replay, the reconstructed account and project boundaries should be identical to the original state before replay
**Validates: Requirements 1.4**

### Property 5: User-Account-Project Access Validation
*For any* user attempting to access a project, the system should verify the user belongs to the project's account before granting access
**Validates: Requirements 1.6**

### Property 6: Permission Derivation from Events
*For any* permission check, the system should be able to derive the permission decision entirely from events in the WAL without hidden state
**Validates: Requirements 1.7**

### Property 7: Deterministic Work Partitioning
*For any* set of workers started with identical configuration, they should receive identical partition assignments when processing the same event stream
**Validates: Requirements 2.1**

### Property 8: Event Processing Mutual Exclusion
*For any* event in the WAL, exactly one worker should process that event, with no duplicate processing across multiple workers
**Validates: Requirements 2.2**

### Property 9: Worker Recovery Without Data Loss
*For any* worker that restarts, it should resume processing from the correct sequence position with no events lost or duplicated
**Validates: Requirements 2.3**

### Property 10: Event-Sourced Partition Assignment
*For any* partition rebalancing operation, the new assignments should be recorded as events in the WAL and be recoverable through replay
**Validates: Requirements 2.4**

### Property 11: Projection Idempotency
*For any* set of events replayed multiple times in any order, the resulting projections should be identical
**Validates: Requirements 2.5**

### Property 12: Worker Restart State Consistency
*For any* individual worker restart, the shared system state should remain consistent and uncorrupted
**Validates: Requirements 2.7**

### Property 13: Backpressure Activation Under Load
*For any* event append rate that exceeds configured capacity thresholds, the system should activate backpressure and return appropriate errors
**Validates: Requirements 3.1**

### Property 14: Per-Tenant Queue Depth Enforcement
*For any* tenant whose queue depth exceeds configured limits, new events for that tenant should be rejected while other tenants remain unaffected
**Validates: Requirements 3.2**

### Property 15: Backpressure Event Recording
*For any* slow consumer detection or backpressure activation, the system should record corresponding backpressure events in the WAL
**Validates: Requirements 3.3, 3.7**

### Property 16: Frontend Backpressure Error Display
*For any* backpressure condition, the frontend should receive and display the actual error messages from the backend without modification
**Validates: Requirements 3.4**

### Property 17: No Silent Event Loss Under Backpressure
*For any* backpressure condition, the system should either successfully process events or return explicit errors, never silently dropping events
**Validates: Requirements 3.5**

### Property 18: Event-Sourced Leader Election
*For any* leader election process, all election steps and the final result should be recorded as events in the WAL
**Validates: Requirements 4.1**

### Property 19: Event-Sourced Worker Coordination
*For any* worker rebalancing operation, the coordination should occur entirely through events with no out-of-band communication
**Validates: Requirements 4.2**

### Property 20: Leader Failover Without Wall-Clock Dependency
*For any* leader failure, the handoff process should complete successfully using only event sequence ordering, not wall-clock time
**Validates: Requirements 4.3**

### Property 21: Coordination State Recovery
*For any* complete system restart, all coordination state should be recoverable from the WAL with no hidden in-memory dependencies
**Validates: Requirements 4.4, 4.5**

### Property 22: Coordination Decision Observability
*For any* coordination decision made by the system, the decision and its rationale should be observable through event inspection
**Validates: Requirements 4.6**

### Property 23: Coordination State Determinism
*For any* replay of coordination events, the resulting coordination state should be identical regardless of replay timing
**Validates: Requirements 4.7**

### Property 24: Resource-Based Autoscaling Signals
*For any* resource pressure (CPU, throughput, queue depth) that exceeds thresholds, the system should generate appropriate autoscaling signal events
**Validates: Requirements 5.1, 5.2, 5.3**

### Property 25: Scaling Signal Content Completeness
*For any* autoscaling signal generated, it should include specific resource recommendations and actionable guidance
**Validates: Requirements 5.6**

### Property 26: Cross-Region Operation Safety
*For any* operation marked as unsafe for cross-region execution, the system should prevent execution and log appropriate warnings
**Validates: Requirements 6.3**

### Property 27: Multi-Region API Warning Inclusion
*For any* API response where multi-region warnings are applicable, the response should include the appropriate warning messages
**Validates: Requirements 6.4**

### Property 28: Frontend API Pattern Consistency
*For any* new backend capability, the frontend should access it using the same API patterns as existing capabilities
**Validates: Requirements 7.1**

### Property 29: Frontend State Derivation from Backend
*For any* state displayed in the frontend, it should be derived from backend APIs without introducing independent frontend state ownership
**Validates: Requirements 7.2**

### Property 30: Backend Error Propagation to Frontend
*For any* error occurring in the backend, the frontend should display the actual error message without modification or interpretation
**Validates: Requirements 7.3**

### Property 31: Frontend Context Persistence
*For any* browser refresh, the frontend should maintain operational context by re-fetching state from backend APIs
**Validates: Requirements 7.4**

### Property 32: Frontend Metric Accuracy
*For any* metric displayed in the frontend, it should match the corresponding metric value from the backend APIs
**Validates: Requirements 7.6**

### Property 33: SDK Functionality Parity
*For any* core operation supported by one SDK, all other SDKs should support the same operation with equivalent functionality
**Validates: Requirements 9.2**

### Property 34: SDK Backpressure Handling
*For any* backpressure response from the backend, the SDKs should handle it appropriately and provide clear feedback to the calling application
**Validates: Requirements 9.3**

### Property 35: SDK Error Message Clarity
*For any* SDK operation failure, the SDK should return meaningful error messages that help developers understand and resolve the issue
**Validates: Requirements 9.4, 9.6**

### Property 36: SDK Stream Offset Management
*For any* stream consumption operation, the SDKs should properly manage offsets to ensure no message loss or duplication
**Validates: Requirements 9.7**

## Error Handling

### Backpressure Error Handling
- **Rate Limit Exceeded**: Return HTTP 429 with `Retry-After` header
- **Queue Depth Exceeded**: Return HTTP 503 with tenant-specific error message
- **System Overload**: Return HTTP 503 with global backpressure indication

### Worker Failure Handling
- **Worker Crash**: Automatic partition reassignment through coordination events
- **Network Partition**: Heartbeat timeout triggers failover
- **Partial Failure**: Graceful degradation with reduced capacity

### Coordination Failure Handling
- **Leader Failure**: Automatic re-election through event consensus
- **Split Brain Prevention**: Event sequence ordering prevents multiple leaders
- **Coordination Deadlock**: Timeout-based recovery with new election

### Data Consistency Error Handling
- **WAL Corruption**: Automatic truncation and recovery from last valid event
- **Projection Inconsistency**: Automatic rebuild from WAL events
- **Cross-Tenant Data Leak**: Immediate isolation and security event logging

## Testing Strategy

### Dual Testing Approach
The system requires both unit testing and property-based testing for comprehensive coverage:

**Unit Tests:**
- Specific examples of account creation, project isolation, worker coordination
- Edge cases like empty inputs, boundary conditions, error scenarios
- Integration points between components
- API endpoint behavior verification

**Property-Based Tests:**
- Universal properties that hold across all inputs using randomized testing
- Minimum 100 iterations per property test to ensure statistical confidence
- Each property test tagged with: **Feature: shrikdb-phase-3-production, Property {number}: {property_text}**

### Property-Based Testing Configuration
- **Testing Library**: Use `gopter` for Go property-based testing
- **Test Iterations**: Minimum 100 iterations per property
- **Input Generation**: Smart generators that create valid account hierarchies, worker configurations, and event sequences
- **Shrinking**: Automatic reduction of failing test cases to minimal examples

### Testing Categories

**Account Management Testing:**
- Property tests for account/project uniqueness and isolation
- Unit tests for specific account creation scenarios
- Integration tests for cross-account access prevention

**Worker Scaling Testing:**
- Property tests for deterministic partitioning and coordination
- Unit tests for worker registration and heartbeat handling
- Load tests with multiple workers processing concurrent events

**Backpressure Testing:**
- Property tests for backpressure activation under various load conditions
- Unit tests for specific rate limiting scenarios
- Integration tests for frontend error display

**Coordination Testing:**
- Property tests for leader election determinism and recovery
- Unit tests for specific coordination scenarios
- Chaos testing for worker failure and network partition scenarios

**SDK Testing:**
- Property tests for SDK operation consistency across languages
- Unit tests for specific SDK error handling
- Integration tests for SDK-backend communication

### Verification Requirements
All testing must verify real system behavior:
- No mock data or simulated responses
- All tests must execute against actual ShrikDB instances
- Verification scripts must produce structured JSON output with clear PASS/FAIL verdicts
- Failed tests must include specific counterexamples and reproduction steps