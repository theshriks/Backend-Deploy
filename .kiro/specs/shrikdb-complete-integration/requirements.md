# Requirements Document

## Introduction

ShrikDB Complete Integration is the production-grade unification of all ShrikDB phases into a single, coherent, end-to-end system. This integration must create a fully working, production-ready database system where Phase 1AB (Go event log) serves as the single source of truth, Phase 2AB (JavaScript streams) operates as a pure derivation layer, and the frontend becomes completely disposable and rebuildable. This is NOT a prototype or demo - all integrations must be production-grade with no mock data, no fake implementations, and no bypass mechanisms.

## Glossary

- **Phase_1AB**: The Go-based event log and document store that serves as the single source of truth
- **Phase_2AB**: The JavaScript-based streams layer that operates as a pure derivation from Phase 1AB
- **Event_Log**: The immutable WAL in Phase 1AB that owns all ordering, hashing, and durability
- **Streams_Layer**: The Kafka-like streaming abstraction built as projection over the event log
- **Backend_APIs**: HTTP/gRPC endpoints that expose Phase 1AB and Phase 2AB functionality
- **Frontend**: The TypeScript/React web interface that must be fully disposable
- **Integration_Point**: A connection between phases that must preserve architectural boundaries
- **Derivation_Layer**: A component that rebuilds its state from the event log without owning data
- **Single_Source_Truth**: Phase 1AB event log is the only authoritative data store
- **Disposable_Component**: A component that can be deleted and perfectly rebuilt from the event log
- **Production_Grade**: No mocks, no demos, no simulations, no fake data, no bypass mechanisms

## Requirements

### Requirement 1: Phase 1AB ↔ Phase 2AB Integration

**User Story:** As a system architect, I want Phase 2AB to integrate with Phase 1AB only via network calls, so that the streams layer remains a pure derivation without touching files or WAL directly.

#### Acceptance Criteria

1. WHEN Phase 2AB needs to write data, THE System SHALL call Phase 1AB AppendEvent API via HTTP/gRPC
2. WHEN Phase 2AB needs to read events, THE System SHALL call Phase 1AB ReadEvents API via network
3. THE Phase_2AB SHALL NOT access WAL files, sequence logic, or hashing directly
4. WHEN Phase 2AB service is killed and restarted, THE System SHALL rebuild all stream state from Phase 1AB event log
5. WHEN Phase 2AB replays events, THE System SHALL produce identical stream state regardless of replay count

### Requirement 2: Backend API Integration

**User Story:** As a frontend developer, I want unified backend APIs that expose both document and stream operations, so that the UI can interact with a single coherent system.

#### Acceptance Criteria

1. WHEN the backend exposes document APIs, THE System SHALL validate authentication using client_id and client_key
2. WHEN the backend exposes stream APIs, THE System SHALL enforce project isolation for all operations
3. WHEN any API writes data, THE System SHALL use ONLY the Phase 1AB AppendEvent mechanism
4. THE Backend_APIs SHALL NOT mutate state directly without going through the event log
5. WHEN APIs return data, THE System SHALL derive all responses from event log state

### Requirement 3: Frontend End-to-End Integration

**User Story:** As a user, I want the frontend to work with real backend data, so that all UI actions create actual events and display real system state.

#### Acceptance Criteria

1. WHEN the frontend creates documents, THE System SHALL call backend APIs that append real events
2. WHEN the frontend displays data, THE System SHALL show only data derived from backend responses
3. THE Frontend SHALL NOT maintain any state that is not sourced from the backend
4. WHEN the frontend publishes stream messages, THE System SHALL create real events in the Phase 1AB log
5. WHEN the frontend shows streams, THE System SHALL display real-time data from Phase 2AB derivations

### Requirement 4: Failure and Recovery Integration

**User Story:** As a system operator, I want the integrated system to survive complete failures, so that all components can be rebuilt from the event log after crashes.

#### Acceptance Criteria

1. WHEN all projections are deleted, THE System SHALL NOT break or lose data
2. WHEN the backend restarts after a crash, THE System SHALL replay the event log and restore all state
3. WHEN Phase 2AB streams are reset, THE System SHALL resume from correct offsets after replay
4. WHEN the frontend reloads after backend recovery, THE System SHALL display the correct recovered state
5. WHEN any component fails, THE System SHALL maintain the event log as the authoritative source

### Requirement 5: Cross-Component Data Flow

**User Story:** As a data architect, I want clear data flow from frontend actions to event log storage, so that every user action follows the same write path.

#### Acceptance Criteria

1. WHEN a user creates a document in the frontend, THE System SHALL flow: Frontend → Backend API → Phase 1AB AppendEvent → WAL
2. WHEN a user publishes a stream message, THE System SHALL flow: Frontend → Backend API → Phase 2AB → Phase 1AB AppendEvent → WAL
3. WHEN the system reads data, THE System SHALL flow: Frontend → Backend API → Phase 1AB/2AB projections → Event log replay
4. THE System SHALL NOT allow any write path that bypasses the Phase 1AB event log
5. WHEN data flows between components, THE System SHALL maintain correlation IDs for tracing

### Requirement 6: Authentication and Authorization Integration

**User Story:** As a security engineer, I want consistent authentication across all integrated components, so that project isolation is maintained end-to-end.

#### Acceptance Criteria

1. WHEN the frontend authenticates, THE System SHALL use Phase 1AB project credentials for all operations
2. WHEN Phase 2AB operations execute, THE System SHALL validate project access through Phase 1AB auth
3. WHEN backend APIs are called, THE System SHALL enforce the same authentication for documents and streams
4. THE System SHALL NOT allow cross-project data access at any integration point
5. WHEN authentication fails, THE System SHALL log failures with correlation IDs across all components

### Requirement 7: Real-Time Integration

**User Story:** As a user, I want real-time updates in the frontend when stream messages are published, so that the UI reflects live system activity.

#### Acceptance Criteria

1. WHEN stream messages are published via Phase 2AB, THE System SHALL make them available for real-time consumption
2. WHEN the frontend subscribes to streams, THE System SHALL receive real-time updates from Phase 2AB
3. WHEN multiple consumer groups exist, THE System SHALL maintain independent offsets in the Phase 1AB event log
4. THE System SHALL NOT use polling or fake real-time mechanisms
5. WHEN real-time connections fail, THE System SHALL resume from correct offsets after reconnection

### Requirement 8: Observability Integration

**User Story:** As a DevOps engineer, I want end-to-end observability across all integrated components, so that I can monitor and debug the complete system.

#### Acceptance Criteria

1. WHEN requests flow through the system, THE System SHALL maintain correlation IDs from frontend to Phase 1AB
2. WHEN the system logs events, THE System SHALL output structured JSON logs with component identification
3. WHEN metrics are collected, THE System SHALL expose metrics for Phase 1AB, Phase 2AB, backend APIs, and integration points
4. WHEN errors occur, THE System SHALL log them with sufficient context to trace across component boundaries
5. WHEN health checks run, THE System SHALL verify connectivity and state consistency across all components

### Requirement 9: Performance Integration

**User Story:** As a performance engineer, I want the integrated system to maintain production-grade performance, so that integration overhead does not degrade system throughput.

#### Acceptance Criteria

1. WHEN the system processes events, THE System SHALL maintain Phase 1AB write throughput despite integration layers
2. WHEN Phase 2AB derives stream state, THE System SHALL not significantly impact Phase 1AB performance
3. WHEN the frontend loads data, THE System SHALL use efficient pagination and caching strategies
4. THE System SHALL NOT introduce unnecessary network round-trips between integrated components
5. WHEN under load, THE System SHALL maintain consistent performance across all integration points

### Requirement 10: Verification and Testing Integration

**User Story:** As a quality assurance engineer, I want comprehensive verification of the integrated system, so that I can confirm production readiness with real data flows.

#### Acceptance Criteria

1. WHEN the verification script runs, THE System SHALL execute real HTTP calls to test all integration points
2. WHEN verification tests document operations, THE System SHALL create real documents and verify they appear in Phase 1AB WAL
3. WHEN verification tests stream operations, THE System SHALL publish real messages and verify Phase 2AB derivation
4. WHEN verification tests recovery, THE System SHALL delete projections, restart services, and verify perfect state recovery
5. WHEN verification completes, THE System SHALL output concrete metrics showing real event counts, not mock data

### Requirement 11: Deployment Integration

**User Story:** As a system administrator, I want the integrated system to deploy as a cohesive unit, so that all components start in the correct order with proper dependencies.

#### Acceptance Criteria

1. WHEN the system starts, THE System SHALL initialize Phase 1AB first as the foundation
2. WHEN Phase 2AB starts, THE System SHALL connect to Phase 1AB and rebuild stream state from events
3. WHEN the backend starts, THE System SHALL verify connectivity to both Phase 1AB and Phase 2AB
4. WHEN the frontend starts, THE System SHALL connect to backend APIs and load initial state
5. WHEN any component fails to start, THE System SHALL provide clear error messages indicating the dependency issue

### Requirement 12: Data Consistency Integration

**User Story:** As a database user, I want data consistency across all views of the system, so that documents and streams show the same underlying events.

#### Acceptance Criteria

1. WHEN a document is created, THE System SHALL make it visible in both document queries and stream messages if applicable
2. WHEN events are replayed, THE System SHALL produce identical state in both Phase 1AB projections and Phase 2AB streams
3. WHEN the frontend displays data, THE System SHALL show consistent information regardless of whether it comes from document or stream APIs
4. THE System SHALL NOT allow inconsistent state between Phase 1AB and Phase 2AB views
5. WHEN data conflicts arise, THE System SHALL resolve them by treating Phase 1AB event log as authoritative