# Implementation Plan: Horizontal Scaling for ShrikDB

## Overview

This implementation plan breaks down the horizontal scaling feature into discrete, incremental tasks. Each task builds on previous work and includes testing to validate correctness. The implementation uses Go and extends the existing ShrikDB codebase.

## Tasks

- [x] 1. Create worker package foundation
  - [x] 1.1 Create worker package structure and core types
    - Create `shrikdb/pkg/worker/worker.go` with Worker struct and WorkerConfig
    - Define WorkerState enum (Initializing, Active, Inactive, Shutdown)
    - Implement basic Start/Stop lifecycle methods
    - _Requirements: 1.1, 1.2_

  - [x] 1.2 Write property test for worker ID determinism
    - **Property 1: Worker ID Determinism**
    - Generate random configurations, verify same config produces same ID
    - **Validates: Requirements 1.1**

- [x] 2. Implement Worker Registry
  - [x] 2.1 Create registry with WAL event recording
    - Create `shrikdb/pkg/worker/registry.go`
    - Implement RegisterWorker that appends WORKER_REGISTERED event to WAL
    - Implement ShutdownWorker that appends WORKER_SHUTDOWN event to WAL
    - Define event payloads (WorkerRegisteredPayload, WorkerShutdownPayload)
    - _Requirements: 1.2, 1.3_

  - [x] 2.2 Implement registry rebuild from WAL
    - Implement RebuildFromWAL method that replays worker events
    - Restore worker state (active/inactive/shutdown) from event sequence
    - Ensure no hidden state beyond what WAL provides
    - _Requirements: 1.4, 1.5_

  - [x] 2.3 Write property test for registry round-trip
    - **Property 3: Worker Registry Round-Trip**
    - Generate worker events, clear registry, replay, verify equivalent state
    - **Validates: Requirements 1.4, 1.5**

  - [x] 2.4 Implement concurrent worker registration
    - Add mutex protection for concurrent registrations
    - Ensure unique worker IDs under concurrent access
    - _Requirements: 1.6_

  - [x] 2.5 Write property test for concurrent worker uniqueness
    - **Property 4: Concurrent Worker Uniqueness**
    - Start multiple workers concurrently, verify all IDs unique
    - **Validates: Requirements 1.6**

- [x] 3. Checkpoint - Registry implementation complete
  - Ensure all registry tests pass
  - Verify WAL events are correctly recorded and replayed
  - Ask the user if questions arise

- [x] 4. Implement Deterministic Part
itioner
  - [x] 4.1 Create partitioner with partition computation
    - Create `shrikdb/pkg/worker/partitioner.go`
    - Implement GetPartition using FNV-1a hash for determinism
    - Support partition keys: ProjectID, StreamID, EventHash
    - _Requirements: 2.1, 2.3, 2.5_

  - [x] 4.2 Write property test for partition assignment determinism
    - **Property 5: Partition Assignment Determinism**
    - Generate events, verify same event always maps to same partition
    - **Validates: Requirements 2.1, 2.3**

  - [x] 4.3 Implement partition-to-worker assignment
    - Implement assignPartitions with sorted worker list for determinism
    - Implement GetWorkerForPartition and GetPartitionsForWorker
    - Ensure each partition maps to exactly one worker
    - _Requirements: 2.2_

  - [x] 4.4 Write property test for partition-worker mapping uniqueness
    - **Property 6: Partition-Worker Mapping Uniqueness**
    - Generate worker sets, verify each partition has exactly one worker
    - **Validates: Requirements 2.2**

  - [x] 4.5 Implement partition rebalancing
    - Implement Rebalance method triggered by worker changes
    - Ensure rebalancing is deterministic based on WAL events
    - _Requirements: 2.7_

  - [x] 4.6 Write property test for partition rebalancing determinism
    - **Property 8: Partition Rebalancing Determinism**
    - Change worker counts, verify deterministic rebalancing
    - **Validates: Requirements 2.7**

  - [x] 4.7 Write property test for partition assignment replay consistency
    - **Property 7: Partition Assignment Replay Consistency**
    - Execute events, replay from WAL, verify identical assignments
    - **Validates: Requirements 2.4**

- [x] 5. Checkpoint - Partitioner implementation complete
  - Ensure all partitioner tests pass
  - Verify deterministic behavior across multiple runs
  - Ask the user if questions arise

- [x] 6. Implement Event Processor
  - [x] 6.1 Create event processor with partition filtering
    - Create `shrikdb/pkg/worker/processor.go`
    - Implement ProcessEvents that filters by assigned partitions
    - Implement ProcessPartition for single partition processing
    - Track last processed sequence per partition
    - _Requirements: 3.1, 3.2, 3.5_

  - [x] 6.2 Write property test for exactly-once event processing
    - **Property 9: Exactly-Once Event Processing**
    - Process events with multiple workers, verify each processed exactly once
    - **Validates: Requirements 3.1, 3.2**

  - [x] 6.3 Implement ordering preservation within partitions
    - Ensure events are processed in sequence order within partition
    - Skip events with sequence <= last processed
    - _Requirements: 3.3_

  - [x] 6.4 Write property test for partition ordering preservation
    - **Property 10: Partition Ordering Preservation**
    - Generate partition events, verify processed in sequence order
    - **Validates: Requirements 3.3**

  - [x] 6.5 Write property test for partition boundary respect
    - **Property 11: Partition Boundary Respect**
    - Verify workers only process events for assigned partitions
    - **Validates: Requirements 3.5**

  - [x] 6.6 Implement idempotent event processing
    - Ensure handler produces same result on reprocessing
    - Use event ID for deduplication if needed
    - _Requirements: 3.6_

  - [x] 6.7 Write property test for event processing idempotence
    - **Property 12: Event Processing Idempotence**
    - Process events multiple times, verify same result
    - **Validates: Requirements 3.6**

- [x] 7. Checkpoint - Event processor implementation complete
  - Ensure all processor tests pass
  - Verify exactly-once semantics with multiple workers
  - Ask the user if questions arise

- [x] 8. Implement Checkpoint Store
  - [x] 8.1 Create checkpoint store with WAL persistence
    - Create `shrikdb/pkg/worker/checkpoint.go`
    - Implement SaveCheckpoint that appends WORKER_CHECKPOINT event
    - Implement GetCheckpoint to retrieve last checkpoint
    - _Requirements: 4.4_

  - [x] 8.2 Implement checkpoint rebuild from WAL
    - Implement RebuildFromWAL for checkpoint recovery
    - Restore last checkpoint per worker per partition
    - _Requirements: 4.4_

  - [x] 8.3 Write property test for checkpoint recovery
    - **Property 14: Checkpoint Recovery**
    - Save checkpoints, restart, verify resume from correct position
    - **Validates: Requirements 4.4**

- [x] 9. Implement Worker Lifecycle Events
  - [x] 9.1 Implement worker inactive detection
    - Add MarkInactive method that records WORKER_INACTIVE event
    - Track last active sequence for detection
    - _Requirements: 4.5_

  - [x] 9.2 Implement worker reactivation
    - Add Reactivate method that records WORKER_REACTIVATED event
    - Restore worker to active state
    - _Requirements: 4.6_

  - [x] 9.3 Write property test for worker lifecycle events
    - **Property 15: Worker Lifecycle Events**
    - Simulate heartbeat failures and reconnections, verify events recorded
    - **Validates: Requirements 4.5, 4.6**

- [x] 10. Implement Failure Recovery
  - [x] 10.1 Implement worker failure handling
    - Handle worker crash mid-processing
    - Ensure no events lost (WAL is source of truth)
    - Ensure no duplicate side effects via checkpoints
    - _Requirements: 4.1, 4.2_

  - [x] 10.2 Implement partition responsibility restoration
    - On worker restart, restore partition assignments from WAL
    - Resume processing from last checkpoint
    - _Requirements: 4.3_

  - [x] 10.3 Write property test for failure recovery correctness
    - **Property 13: Failure Recovery Correctness**
    - Kill workers mid-processing, verify no lost events, no duplicates
    - **Validates: Requirements 4.1, 4.2, 4.3**

- [x] 11. Checkpoint - Recovery implementation complete
  - Ensure all recovery tests pass
  - Verify system recovers correctly from worker failures
  - Ask the user if questions arise

- [x] 12. Implement Metrics Collector
  - [x] 12.1 Create metrics collector with WAL-derived metrics
    - Create `shrikdb/pkg/worker/metrics.go`
    - Implement GetSystemMetrics returning active workers, partitions
    - Implement GetWorkerMetrics and GetPartitionMetrics
    - Calculate lag per partition (latest - processed sequence)
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x] 12.2 Write property test for metrics consistency
    - **Property 16: Metrics Consistency**
    - Generate states, verify metrics match WAL state
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.6**

- [x] 13. Integrate Worker System with Server
  - [x] 13.1 Add worker endpoints to HTTP server
    - Add GET /api/workers endpoint for worker list
    - Add GET /api/workers/metrics endpoint for metrics
    - Add GET /api/partitions endpoint for partition info
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x] 13.2 Wire worker components together
    - Create WorkerManager to coordinate components
    - Initialize registry, partitioner, processor, checkpoint store
    - Start worker processing loop
    - _Requirements: 3.4, 3.7_

- [x] 14. Checkpoint - Integration complete
  - Ensure all integration tests pass
  - Verify HTTP endpoints return correct data
  - Ask the user if questions arise

- [x] 15. Create Verification Script
  - [x] 15.1 Implement verification script
    - Create `shrikdb/cmd/verify-horizontal-scaling/main.go`
    - Start multiple workers concurrently
    - Append real events to WAL
    - Verify partition-to-worker mapping is deterministic
    - _Requirements: 6.1, 6.2, 6.3_

  - [x] 15.2 Implement failure and recovery verification
    - Kill one worker mid-processing
    - Restart system and replay from WAL
    - Confirm deterministic assignment after replay
    - Confirm no duplicate processing
    - Confirm correct recovery with no data loss
    - _Requirements: 6.4, 6.5, 6.6, 6.7, 6.8_

  - [x] 15.3 Implement structured output and verdict
    - Output structured logs (JSON format)
    - Output deterministic results
    - Output clear PASS/FAIL verdict
    - No mocks, no fake success messages
    - _Requirements: 6.9, 6.10_

- [x] 16. Final Checkpoint - All tests pass
  - Run full test suite
  - Run verification script
  - Verify all exit criteria met:
    - Multiple workers run concurrently
    - Each event processed exactly once
    - Partition ownership is deterministic
    - System fully recovers after worker failure
    - Verification script passes with real data
  - Ask the user if questions arise

## Notes

- All tasks including property-based tests are required for comprehensive correctness
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties using go-fuzz/rapid (100+ iterations)
- Unit tests validate specific examples and edge cases
- All worker state must be derivable from WAL events - no hidden state
