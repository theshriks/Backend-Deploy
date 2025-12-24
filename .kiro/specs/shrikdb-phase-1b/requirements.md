# Requirements Document

## Introduction

ShrikDB Phase 1B implements a production-grade document database as a pure projection over the existing event log from Phase 1A. This phase builds a Mongo-like document interface while maintaining the event log as the single source of truth. The document projection must be completely disposable and rebuildable from events at any time.

## Glossary

- **Event Log**: The immutable sequence of events that serves as the single source of truth (implemented in Phase 1A)
- **Document Projection**: A derived view of document state built by replaying events from the event log
- **Projection Engine**: The system component that processes events to maintain document state
- **Query Engine**: The system component that handles document queries and retrieval
- **Replay**: The process of rebuilding document projections by processing all events from the beginning
- **ShrikDB**: The event-sourced database system being implemented
- **Document Store**: The storage mechanism for projected document state (separate from event log)

## Requirements

### Requirement 1

**User Story:** As a developer, I want to create documents through an event-driven API, so that all document changes are properly recorded in the event log.

#### Acceptance Criteria

1. WHEN a user creates a document THEN the system SHALL append a DocumentCreated event to the event log before updating the projection
2. WHEN a user updates a document THEN the system SHALL append a DocumentUpdated event to the event log before updating the projection
3. WHEN a user deletes a document THEN the system SHALL append a DocumentDeleted event to the event log before updating the projection
4. WHEN an event is successfully appended THEN the system SHALL update the document projection to reflect the change
5. IF projection update fails THEN the system SHALL preserve the event in the log and continue operation

### Requirement 2

**User Story:** As a developer, I want to query documents using a Mongo-like interface, so that I can retrieve document data efficiently.

#### Acceptance Criteria

1. WHEN a user queries by document ID THEN the system SHALL return the current projected state of that document
2. WHEN a user queries by simple field values THEN the system SHALL return all matching documents from the projection
3. WHEN a user requests paginated results THEN the system SHALL return the specified page of results with pagination metadata
4. WHEN a document does not exist in the projection THEN the system SHALL return appropriate not-found responses
5. WHILE serving queries THEN the system SHALL read only from the document projection and never from the event log

### Requirement 3

**User Story:** As a system administrator, I want the document projection to be completely rebuildable from events, so that I can recover from projection corruption or implement schema changes.

#### Acceptance Criteria

1. WHEN replay is initiated THEN the system SHALL process all DocumentCreated, DocumentUpdated, and DocumentDeleted events in chronological order
2. WHEN processing DocumentCreated events THEN the system SHALL create new document entries in the projection
3. WHEN processing DocumentUpdated events THEN the system SHALL modify existing document entries in the projection
4. WHEN processing DocumentDeleted events THEN the system SHALL remove document entries from the projection
5. WHEN replay completes THEN the system SHALL produce identical document state regardless of previous projection state

### Requirement 4

**User Story:** As a system operator, I want to monitor projection health and performance, so that I can ensure system reliability.

#### Acceptance Criteria

1. WHEN the system is running THEN the system SHALL expose a documents_count metric showing total projected documents
2. WHEN events are processed THEN the system SHALL expose a projection_lag metric showing delay between event creation and projection update
3. WHEN replay operations occur THEN the system SHALL expose a replay_rebuild_time metric showing rebuild duration
4. WHEN projection failures occur THEN the system SHALL log detailed error information for debugging
5. WHEN replay produces different results THEN the system SHALL log mismatch details for investigation

### Requirement 5

**User Story:** As a frontend developer, I want to interact with documents through a consistent API, so that the UI remains functional regardless of backend projection state.

#### Acceptance Criteria

1. WHEN the frontend creates documents THEN the system SHALL use only the event API endpoints for write operations
2. WHEN the frontend reads documents THEN the system SHALL use only the projection API endpoints for read operations
3. WHEN the frontend displays document lists THEN the system SHALL support pagination through projection queries
4. WHEN projection rebuilds occur THEN the system SHALL maintain API availability and consistency
5. WHILE the frontend operates THEN the system SHALL prevent any direct document store manipulation bypassing events

### Requirement 6

**User Story:** As a quality assurance engineer, I want automated verification of projection correctness, so that I can validate system integrity.

#### Acceptance Criteria

1. WHEN verification runs THEN the system SHALL capture current document projection state as baseline
2. WHEN verification deletes the document store THEN the system SHALL remove all projected document data
3. WHEN verification replays events THEN the system SHALL rebuild document projections from the complete event log
4. WHEN verification compares states THEN the system SHALL validate that rebuilt state matches the original baseline exactly
5. WHEN verification completes THEN the system SHALL output concrete results showing success or specific mismatches

### Requirement 7

**User Story:** As a database user, I want document operations to behave like MongoDB, so that I can use familiar patterns and expectations.

#### Acceptance Criteria

1. WHEN creating documents THEN the system SHALL assign unique identifiers and return them to the client
2. WHEN updating documents THEN the system SHALL support partial updates that modify only specified fields
3. WHEN querying documents THEN the system SHALL support field selection and basic filtering operations
4. WHEN documents are deleted THEN the system SHALL remove them from query results immediately after projection update
5. WHILE handling concurrent operations THEN the system SHALL maintain consistency through event ordering