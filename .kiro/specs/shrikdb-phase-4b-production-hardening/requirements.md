# Requirements Document

## Introduction

ShrikDB Phase 4B delivers a fully integrated, production-grade system where Frontend, Backend, and ShrikDB Core (WAL engine) operate as one coherent, observable, benchmarked platform. This phase eliminates all mocks, simulations, and fake metrics. Every signal must be real, measurable, and reproducible. The system must survive restarts, failures, and replay while maintaining correctness guarantees. All writes flow through the ShrikDB WAL as the single source of truth, with no bypass paths or shadow state.

## Glossary

- **ShrikDB_Core**: The Go-based WAL engine that owns all event ordering, hashing, and durability
- **WAL**: Write-Ahead Log, the immutable append-only event store that is the single source of truth
- **Backend**: The Node.js unified API layer that routes all operations through ShrikDB Core
- **Frontend**: The React dashboard application for system interaction and monitoring
- **WebSocket_Service**: Real-time streaming service for live event delivery
- **Projection**: Derived state rebuilt from WAL events (documents, streams, metrics)
- **Sequence_Number**: Monotonically increasing event identifier in the WAL
- **Replay**: Process of rebuilding all projections from sequence 0
- **Exactly_Once**: Processing guarantee where each event affects state exactly one time
- **Deterministic_Recovery**: Property where replay always produces identical state
- **Backpressure**: Flow control mechanism that slows producers when system is overloaded
- **Diagnostic_UI**: Minimal, read-only observability interface for production monitoring
- **Benchmark**: Measured performance metric with no exaggeration or simulation
- **Verification_Script**: Automated test that validates system correctness with real data

## Requirements

### Requirement 1: Single Source of Truth

**User Story:** As a system architect, I want all writes to flow through the ShrikDB WAL, so that there is exactly one authoritative data store with no bypass paths.

#### Acceptance Criteria

1. THE System SHALL route all write operations through the ShrikDB AppendEvent API
2. THE System SHALL NOT maintain any side databases, shadow state, or bypass paths
3. WHEN any component writes data, THE System SHALL append an event to the WAL with a sequence number
4. WHEN projections are deleted, THE System SHALL rebuild them perfectly from the WAL
5. WHEN the system restarts, THE System SHALL recover all state from the WAL without data loss

### Requirement 2: Full System Integration

**User Story:** As a developer, I want Frontend, Backend, and ShrikDB Core fully wired together, so that user actions result in real WAL events and real projections.

#### Acceptance Criteria

1. WHEN a user performs an action in the Frontend, THE System SHALL create a real WAL event with a sequence number
2. WHEN the Backend processes requests, THE System SHALL call ShrikDB Core APIs (not mock implementations)
3. WHEN projections are queried, THE System SHALL return state derived from WAL events
4. WHEN WebSocket streams deliver events, THE System SHALL source them from real WAL activity
5. WHEN any component restarts, THE System SHALL maintain correctness without losing data

### Requirement 3: Authentication Flow Integration

**User Story:** As a security engineer, I want authentication to flow correctly from Frontend through Backend to ShrikDB, so that tenant isolation is enforced at append time.

#### Acceptance Criteria

1. WHEN the Frontend authenticates, THE System SHALL use real credentials stored in the WAL
2. WHEN the Backend validates credentials, THE System SHALL query ShrikDB Core (not local cache)
3. WHEN events are appended, THE System SHALL enforce tenant/account/project isolation
4. WHEN cross-tenant access is attempted, THE System SHALL reject with 403 status
5. WHEN authentication fails, THE System SHALL log failures with correlation IDs

### Requirement 4: Real-Time Event Streaming

**User Story:** As a user, I want to see real-time events from the WAL, so that I can monitor live system activity.

#### Acceptance Criteria

1. WHEN events are appended to the WAL, THE System SHALL broadcast them via WebSocket
2. WHEN the Frontend subscribes to events, THE System SHALL receive real-time updates (not derived mocks)
3. WHEN events are displayed, THE System SHALL show sequence number, event type, project_id, and timestamp
4. WHEN the WebSocket connection fails, THE System SHALL reconnect and resume from the last received sequence
5. WHEN no events are occurring, THE System SHALL NOT generate fake activity

### Requirement 5: Deterministic Replay

**User Story:** As a system operator, I want to replay the WAL from sequence 0, so that I can verify deterministic recovery and state consistency.

#### Acceptance Criteria

1. WHEN replay is triggered, THE System SHALL rebuild all projections from sequence 0
2. WHEN replay completes, THE System SHALL produce identical state to the original
3. WHEN replay is run multiple times, THE System SHALL produce the same result every time
4. WHEN the Frontend displays replay status, THE System SHALL show real progress (events processed, current sequence)
5. WHEN replay encounters errors, THE System SHALL log them with the failing sequence number

### Requirement 6: Live Event Log Viewer

**User Story:** As a DevOps engineer, I want to view live events from the WAL, so that I can inspect real-time system activity.

#### Acceptance Criteria

1. WHEN the Event Log Viewer loads, THE System SHALL display recent events from the WAL
2. WHEN new events are appended, THE System SHALL update the viewer in real-time via WebSocket
3. WHEN events are displayed, THE System SHALL show sequence number, event type, project_id, and timestamp
4. THE Event Log Viewer SHALL be read-only (no write operations)
5. WHEN the viewer is filtered by project, THE System SHALL show only events for that project

### Requirement 7: Metrics Panel

**User Story:** As a performance engineer, I want to see real throughput and latency metrics, so that I can identify bottlenecks.

#### Acceptance Criteria

1. WHEN the Metrics Panel loads, THE System SHALL display real throughput (events/sec)
2. WHEN events are appended, THE System SHALL measure and display append latency
3. WHEN projections are read, THE System SHALL measure and display read latency
4. WHEN replay is running, THE System SHALL display replay speed (events/sec)
5. WHEN worker/partition status exists, THE System SHALL display it in real-time

### Requirement 8: Error and Health Panel

**User Story:** As a system administrator, I want to see authentication failures, quota violations, and service health, so that I can diagnose issues.

#### Acceptance Criteria

1. WHEN authentication fails, THE System SHALL log the failure and display it in the Error Panel
2. WHEN quota violations occur, THE System SHALL log them and display usage metrics
3. WHEN replay errors occur, THE System SHALL display the failing sequence number and error message
4. WHEN services are healthy, THE System SHALL display green status indicators
5. WHEN services are unhealthy, THE System SHALL display red status indicators with error details

### Requirement 9: Benchmark Hardening

**User Story:** As a performance engineer, I want truthful, comparable benchmarks, so that I can measure real system performance.

#### Acceptance Criteria

1. WHEN WAL append throughput is measured, THE System SHALL report real events/sec (not simulated)
2. WHEN read latency is measured, THE System SHALL report real milliseconds from projections
3. WHEN replay speed is measured, THE System SHALL report real events/sec from sequence 0
4. WHEN WebSocket delivery latency is measured, THE System SHALL report real end-to-end milliseconds
5. WHEN bottlenecks are identified, THE System SHALL provide evidence (not speculation)

### Requirement 10: Crash Recovery

**User Story:** As a system operator, I want to validate crash recovery, so that I can trust the system to restore state correctly.

#### Acceptance Criteria

1. WHEN projections are deleted and the system restarts, THE System SHALL rebuild all state from the WAL
2. WHEN the Backend crashes and restarts, THE System SHALL reconnect to ShrikDB and restore sessions
3. WHEN the Frontend crashes and restarts, THE System SHALL reconnect to the Backend and restore UI state
4. WHEN recovery completes, THE System SHALL resume normal operations with no data loss
5. WHEN recovery is verified, THE System SHALL confirm sequence monotonicity and state consistency

### Requirement 11: Exactly-Once Processing

**User Story:** As a data engineer, I want exactly-once processing guarantees, so that events affect state exactly one time.

#### Acceptance Criteria

1. WHEN events are processed, THE System SHALL ensure each event affects projections exactly once
2. WHEN replay is triggered, THE System SHALL produce the same final state as the original processing
3. WHEN duplicate events are detected, THE System SHALL reject them with an error
4. WHEN processing is interrupted, THE System SHALL resume from the last committed checkpoint
5. WHEN exactly-once is violated, THE System SHALL log the violation with evidence

### Requirement 12: Backpressure Behavior

**User Story:** As a system operator, I want to validate backpressure under load, so that the system remains stable when overloaded.

#### Acceptance Criteria

1. WHEN the system is overloaded, THE System SHALL apply backpressure to slow down producers
2. WHEN backpressure is applied, THE System SHALL maintain data integrity and event ordering
3. WHEN backpressure is released, THE System SHALL resume normal throughput
4. WHEN backpressure occurs, THE System SHALL log it with metrics (queue depth, wait time)
5. WHEN backpressure is tested, THE System SHALL demonstrate stable behavior (no crashes)

### Requirement 13: Docker Production Packaging

**User Story:** As a DevOps engineer, I want a Dockerized deployment, so that I can run the entire system in production.

#### Acceptance Criteria

1. THE System SHALL provide a Dockerfile or docker-compose that runs ShrikDB Core, Backend, WebSocket Service, and Frontend
2. WHEN containers start, THE System SHALL initialize in the correct order with health checks
3. WHEN containers restart, THE System SHALL recover state automatically from the WAL
4. WHEN containers are stopped, THE System SHALL persist WAL data to volumes
5. WHEN containers start cleanly, THE System SHALL not require manual intervention

### Requirement 14: End-to-End Verification

**User Story:** As a QA engineer, I want a verification script that validates the entire system, so that I can certify production readiness.

#### Acceptance Criteria

1. WHEN the verification script runs, THE System SHALL create real projects and accounts
2. WHEN events are appended, THE System SHALL verify they appear in the WAL with sequence numbers
3. WHEN events are read via API, THE System SHALL verify they match what was appended
4. WHEN events are delivered via WebSocket, THE System SHALL verify real-time delivery
5. WHEN replay is forced from sequence 0, THE System SHALL verify sequence monotonicity and state consistency

### Requirement 15: Verification Output

**User Story:** As a QA engineer, I want machine-verifiable verification results, so that I can automate production certification.

#### Acceptance Criteria

1. WHEN verification completes, THE System SHALL output results in JSON format
2. WHEN verification succeeds, THE System SHALL report pass/fail for each test
3. WHEN verification fails, THE System SHALL report the failing test with error details
4. WHEN verification measures performance, THE System SHALL report real numbers (events/sec, latency)
5. WHEN verification logs are generated, THE System SHALL include timestamps and correlation IDs

### Requirement 16: No Mock Data

**User Story:** As a system architect, I want zero mock data in production, so that all displayed information reflects real system state.

#### Acceptance Criteria

1. THE Frontend SHALL NOT display any hardcoded or mock values
2. THE Backend SHALL NOT generate fake metrics or synthetic data
3. THE WebSocket Service SHALL NOT simulate events (only real WAL events)
4. THE Metrics Panel SHALL NOT show placeholder data (only real measurements)
5. WHEN no data exists, THE System SHALL display "No data" (not fake data)

### Requirement 17: Diagnostic UI Constraints

**User Story:** As a product manager, I want minimal diagnostic UI, so that we focus on production functionality (not experimental UX).

#### Acceptance Criteria

1. THE Diagnostic UI SHALL be read-only (no write operations)
2. THE Diagnostic UI SHALL focus on observability (events, metrics, health)
3. THE Diagnostic UI SHALL NOT include decorative or experimental features
4. THE Diagnostic UI SHALL be production-appropriate (no debug-only features)
5. WHEN new UI is needed, THE System SHALL create only essential components

### Requirement 18: Sequence Monotonicity

**User Story:** As a data engineer, I want to verify sequence monotonicity, so that I can trust event ordering.

#### Acceptance Criteria

1. WHEN events are appended, THE System SHALL assign monotonically increasing sequence numbers
2. WHEN events are read, THE System SHALL return them in sequence order
3. WHEN replay is triggered, THE System SHALL process events in sequence order
4. WHEN sequence gaps are detected, THE System SHALL log them as errors
5. WHEN verification runs, THE System SHALL confirm no sequence gaps or duplicates

### Requirement 19: State Consistency

**User Story:** As a system operator, I want to verify state consistency after replay, so that I can trust recovery.

#### Acceptance Criteria

1. WHEN projections are rebuilt from the WAL, THE System SHALL produce identical state to the original
2. WHEN document counts are queried, THE System SHALL return the same count before and after replay
3. WHEN stream offsets are queried, THE System SHALL return the same offsets before and after replay
4. WHEN metrics are queried, THE System SHALL return consistent values before and after replay
5. WHEN state inconsistencies are detected, THE System SHALL log them with evidence

### Requirement 20: No Data Loss

**User Story:** As a database user, I want zero data loss guarantees, so that I can trust the system with critical data.

#### Acceptance Criteria

1. WHEN the system crashes, THE System SHALL recover all committed events from the WAL
2. WHEN projections are deleted, THE System SHALL rebuild them without losing any events
3. WHEN replay is triggered, THE System SHALL process all events from sequence 0 to the latest
4. WHEN verification runs, THE System SHALL confirm all appended events are present
5. WHEN data loss is detected, THE System SHALL fail verification with clear evidence
