# Requirements Document

## Introduction

This document specifies the requirements for implementing true horizontal scaling in ShrikDB through a multi-worker execution model. The system will enable deterministic partitioning of work across multiple workers while preserving all existing guarantees: event-sourcing, replay safety, and WAL as the single source of truth.

The horizontal scaling feature extends the current system without refactoring or replacing existing components. Workers do not "own data" — they own responsibility derived from events. All worker state must be event-sourced, replayable, deterministic, and recoverable after full process termination.

## Glossary

- **Worker**: A processing unit with a unique identity that consumes events from the WAL and processes them according to partition assignment
- **Worker_ID**: A unique identifier for each worker instance, persisted across restarts via WAL replay
- **Partition**: A logical grouping of events determined by a partition key (project_id, stream_id, or hash of event key)
- **Partition_Key**: The field used to deterministically assign events to partitions (e.g., project_id)
- **Partition_Assignment**: The mapping of partitions to workers, derived from events and recomputable during replay
- **WAL**: Write-Ahead Log - the single source of truth for all events in the system
- **Worker_Registry**: The event-sourced registry of active workers, rebuilt from WAL events
- **Event_Processor**: The component within a worker that processes events for assigned partitions
- **Lag**: The difference between the latest event sequence and the last processed sequence for a partition

## Requirements

### Requirement 1: Worker Identity and Lifecycle

**User Story:** As a system operator, I want workers to have persistent identities that survive restarts, so that partition assignments remain stable and deterministic.

#### Acceptance Criteria

1. WHEN a worker starts, THE Worker_Registry SHALL assign a unique worker_id that is deterministic based on configuration
2. WHEN a worker registers, THE WAL SHALL record a WORKER_REGISTERED event containing worker_id, timestamp, and configuration
3. WHEN a worker shuts down gracefully, THE WAL SHALL record a WORKER_SHUTDOWN event containing worker_id and timestamp
4. WHEN a worker restarts, THE Worker_Registry SHALL restore the worker's identity by replaying WORKER_REGISTERED and WORKER_SHUTDOWN events from the WAL
5. THE Worker_Registry SHALL NOT maintain any hidden global state that cannot be rebuilt via WAL replay
6. WHEN multiple workers start concurrently, THE Worker_Registry SHALL ensure each receives a unique worker_id without conflicts

### Requirement 2: Deterministic Partitioning Model

**User Story:** As a system architect, I want events to be deterministically assigned to partitions and workers, so that the system behaves predictably and can be replayed correctly.

#### Acceptance Criteria

1. THE Partition_Assignment SHALL map every event to exactly one partition based on the partition key
2. THE Partition_Assignment SHALL map every partition to exactly one worker at any given time
3. WHEN the same partition key is used, THE Partition_Assignment SHALL always produce the same partition number regardless of runtime order
4. WHEN replaying events, THE Partition_Assignment SHALL produce identical partition assignments as the original execution
5. THE Partition_Assignment SHALL support partition keys including: project_id, stream_id, and hash of event key
6. THE Partition_Assignment SHALL be computable without accessing external state beyond the event itself
7. WHEN the number of workers changes, THE Partition_Assignment SHALL rebalance partitions deterministically based on worker events in the WAL

### Requirement 3: Multi-Worker Concurrent Execution

**User Story:** As a system operator, I want multiple workers to process events concurrently, so that the system can scale horizontally to handle increased load.

#### Acceptance Criteria

1. WHEN multiple workers are running, THE Event_Processor SHALL ensure each event is processed by exactly one worker
2. WHEN multiple workers are running, THE Event_Processor SHALL ensure no events are missed during processing
3. WHEN processing events within a partition, THE Event_Processor SHALL preserve the original event ordering
4. THE Event_Processor SHALL consume events from the same WAL across all workers
5. THE Event_Processor SHALL respect partition boundaries and only process events for assigned partitions
6. THE Event_Processor SHALL be idempotent such that reprocessing an event produces the same result
7. WHEN at least two workers are running, THE System SHALL demonstrate concurrent event processing with verifiable logs

### Requirement 4: Restart and Failure Safety

**User Story:** As a system operator, I want the system to recover correctly from worker failures, so that no data is lost and processing continues without duplicates.

#### Acceptance Criteria

1. WHEN a worker is killed mid-processing, THE System SHALL not lose any events
2. WHEN a worker is killed mid-processing, THE System SHALL not produce duplicate side effects upon restart
3. WHEN a worker restarts after failure, THE Partition_Assignment SHALL restore partition responsibility deterministically
4. WHEN a worker restarts, THE Event_Processor SHALL resume processing from the last committed position
5. IF a worker fails to heartbeat, THEN THE Worker_Registry SHALL mark the worker as inactive via a WORKER_INACTIVE event
6. WHEN a previously inactive worker reconnects, THE Worker_Registry SHALL record a WORKER_REACTIVATED event

### Requirement 5: Worker Observability

**User Story:** As a system operator, I want to monitor worker health and performance, so that I can identify issues and optimize the system.

#### Acceptance Criteria

1. THE Metrics_Collector SHALL expose the count of active workers derived from WAL events
2. THE Metrics_Collector SHALL expose the partition assignments for each active worker
3. THE Metrics_Collector SHALL expose the count of events processed per worker
4. THE Metrics_Collector SHALL expose the lag per partition (difference between latest and processed sequence)
5. THE Metrics_Collector SHALL reflect real execution state, not simulated counters
6. WHEN queried, THE Metrics_Collector SHALL return metrics that are consistent with the current WAL state

### Requirement 6: Verification and Testing

**User Story:** As a developer, I want a verification script that proves the system works correctly, so that I can validate horizontal scaling behavior.

#### Acceptance Criteria

1. THE Verification_Script SHALL start multiple workers concurrently
2. THE Verification_Script SHALL append real events to the WAL
3. THE Verification_Script SHALL verify that partition-to-worker mapping is deterministic
4. THE Verification_Script SHALL kill one worker mid-processing and verify recovery
5. THE Verification_Script SHALL restart the system and replay from WAL
6. THE Verification_Script SHALL confirm deterministic assignment after replay
7. THE Verification_Script SHALL confirm no duplicate processing occurred
8. THE Verification_Script SHALL confirm correct recovery with no data loss
9. THE Verification_Script SHALL output structured logs with clear PASS/FAIL verdict
10. THE Verification_Script SHALL NOT use mocks, fake workers, or simulated execution
