# Requirements Document

## Introduction

ShrikDB Phase 3B implements Scale & Isolation Hardening as a direct extension of Phase 3A multi-tenancy. This phase ensures the system remains safe under load by preventing noisy-neighbor effects, enforcing namespace-level quotas, and proving isolation under concurrent operations. All decisions must be event-derived (no wall-clock timing dependencies) to maintain deterministic replay. This phase prepares the system for horizontal scaling in Phase 4.

## Glossary

- **Namespace_Quota**: Resource limits enforced at the namespace level within a tenant
- **Noisy_Neighbor**: A namespace or tenant that consumes excessive resources, potentially starving others
- **Fair_Scheduler**: Component that ensures equitable resource distribution across namespaces
- **Backpressure**: Mechanism to slow down overloaded namespaces without blocking others
- **Throughput_Guarantee**: Minimum guaranteed throughput per namespace regardless of system load
- **Event_Derived_Decision**: A scheduling or quota decision based solely on event data, not wall-clock time
- **Throttled_Event**: An event indicating a namespace was rate-limited due to quota or fairness rules
- **Queue_Depth**: Number of pending operations per namespace awaiting processing
- **Sequence_Integrity**: Property that sequence numbers remain correct per namespace under concurrent writes
- **Starvation**: Condition where a namespace receives no processing time due to other namespaces' load

## Requirements

### Requirement 1: Namespace-Level Quota Configuration

**User Story:** As a system administrator, I want to configure quotas at the namespace level, so that I can control resource usage more granularly than tenant-level quotas.

#### Acceptance Criteria

1. WHEN a namespace quota is configured, THE System SHALL append a NAMESPACE_QUOTA_SET event with tenant_id, namespace_id, quota_type, and limit_value
2. WHEN a namespace quota is updated, THE System SHALL append a NAMESPACE_QUOTA_UPDATED event with tenant_id, namespace_id, quota_type, old_value, and new_value
3. WHEN namespace quotas are queried, THE System SHALL return current limits for max_events_per_window, max_streams, and max_consumer_groups per namespace
4. WHEN the system replays events, THE System SHALL rebuild all namespace quota state deterministically from NAMESPACE_QUOTA_* events
5. WHEN a namespace has no explicit quota, THE System SHALL inherit the tenant-level quota as the default limit

### Requirement 2: Namespace-Level Rate Limiting

**User Story:** As a system operator, I want to enforce rate limits per namespace, so that one namespace cannot flood the system with events.

#### Acceptance Criteria

1. WHEN events are appended to a namespace, THE System SHALL check the namespace rate limit before accepting the write
2. WHEN a namespace exceeds its rate limit, THE System SHALL reject the write and append a NAMESPACE_RATE_LIMIT_EXCEEDED event
3. WHEN rate limits are enforced, THE System SHALL track event counts using event-derived windows (not wall-clock time)
4. WHEN a rate-limited namespace's window resets, THE System SHALL resume accepting writes without manual intervention
5. WHEN rate limit state is queried, THE System SHALL return current_count, limit, and window_events_remaining per namespace

### Requirement 3: Namespace Stream and Consumer Caps

**User Story:** As a tenant administrator, I want to limit the number of streams and consumer groups per namespace, so that I can prevent resource exhaustion.

#### Acceptance Criteria

1. WHEN a stream is created, THE System SHALL check the namespace max_streams quota before allowing creation
2. WHEN a consumer group is created, THE System SHALL check the namespace max_consumer_groups quota before allowing creation
3. WHEN a stream or consumer group creation exceeds the cap, THE System SHALL reject the operation and append a NAMESPACE_CAP_EXCEEDED event
4. WHEN streams or consumer groups are deleted, THE System SHALL decrement the namespace count to allow new creations
5. WHEN cap state is queried, THE System SHALL return current_streams, max_streams, current_consumer_groups, and max_consumer_groups per namespace

### Requirement 4: Quota Violation Event Logging

**User Story:** As a security engineer, I want all quota violations logged as events, so that I can audit resource abuse and replay quota state.

#### Acceptance Criteria

1. WHEN any quota violation occurs, THE System SHALL append a QUOTA_VIOLATION event with tenant_id, namespace_id, quota_type, attempted_value, and current_usage
2. WHEN quota violations are replayed, THE System SHALL rebuild violation counts and patterns deterministically
3. WHEN quota violation events are queried, THE System SHALL support filtering by tenant_id, namespace_id, and quota_type
4. WHEN a namespace accumulates excessive violations, THE System SHALL emit a NAMESPACE_ABUSE_DETECTED event for alerting
5. WHEN violation events are stored, THE System SHALL include correlation_id for tracing the originating request

### Requirement 5: Fair Scheduling Between Namespaces

**User Story:** As a system architect, I want fair scheduling between namespaces, so that no single namespace can monopolize system resources.

#### Acceptance Criteria

1. WHEN multiple namespaces have pending operations, THE System SHALL process them using round-robin or weighted-fair scheduling
2. WHEN scheduling decisions are made, THE System SHALL base them on event-derived state (not wall-clock timing)
3. WHEN a namespace has no pending operations, THE System SHALL skip it in the scheduling rotation without penalty
4. WHEN scheduling state is queried, THE System SHALL return operations_processed and scheduling_weight per namespace
5. WHEN the system replays events, THE System SHALL reproduce identical scheduling decisions given the same event sequence

### Requirement 6: Backpressure for Overloaded Namespaces

**User Story:** As a system operator, I want backpressure applied to overloaded namespaces, so that they cannot degrade performance for other namespaces.

#### Acceptance Criteria

1. WHEN a namespace queue depth exceeds the threshold, THE System SHALL apply backpressure by delaying that namespace's operations
2. WHEN backpressure is applied, THE System SHALL append a NAMESPACE_BACKPRESSURE_APPLIED event with tenant_id, namespace_id, and queue_depth
3. WHEN backpressure is released, THE System SHALL append a NAMESPACE_BACKPRESSURE_RELEASED event
4. WHEN backpressure is active, THE System SHALL continue processing other namespaces at normal speed
5. WHEN backpressure state is queried, THE System SHALL return is_backpressured, queue_depth, and threshold per namespace

### Requirement 7: Guaranteed Minimum Throughput

**User Story:** As a tenant user, I want guaranteed minimum throughput for my namespace, so that other tenants' load cannot completely starve my operations.

#### Acceptance Criteria

1. WHEN a namespace is configured, THE System SHALL allow setting a minimum_throughput_guarantee value
2. WHEN system load is high, THE System SHALL ensure each namespace receives at least its guaranteed minimum throughput
3. WHEN a namespace cannot receive its guaranteed throughput, THE System SHALL append a THROUGHPUT_GUARANTEE_VIOLATED event
4. WHEN throughput guarantees are enforced, THE System SHALL use event-derived metrics (not wall-clock measurements)
5. WHEN throughput state is queried, THE System SHALL return guaranteed_minimum, actual_throughput, and guarantee_met per namespace

### Requirement 8: Concurrent Write Isolation

**User Story:** As a database engineer, I want concurrent writes from multiple namespaces to be isolated, so that they do not interfere with each other.

#### Acceptance Criteria

1. WHEN concurrent writes occur from 5+ namespaces, THE System SHALL process them without data corruption or interference
2. WHEN concurrent writes complete, THE System SHALL maintain correct sequence numbers per namespace
3. WHEN concurrent writes are processed, THE System SHALL ensure no namespace experiences starvation
4. WHEN concurrent write state is verified, THE System SHALL confirm each namespace's events are correctly ordered
5. WHEN the system replays concurrent writes, THE System SHALL produce identical per-namespace state regardless of processing order

### Requirement 9: Sequence Number Integrity Under Load

**User Story:** As a data engineer, I want sequence numbers to remain correct per namespace under load, so that I can rely on event ordering for replay.

#### Acceptance Criteria

1. WHEN events are appended under high load, THE System SHALL maintain monotonically increasing sequence numbers per namespace
2. WHEN sequence numbers are assigned, THE System SHALL ensure no gaps or duplicates within a namespace
3. WHEN sequence integrity is verified, THE System SHALL confirm global sequence and per-namespace sequence are both correct
4. WHEN sequence state is queried, THE System SHALL return last_global_sequence and last_namespace_sequence per namespace
5. WHEN the system replays events, THE System SHALL verify sequence integrity as part of replay validation

### Requirement 10: Starvation Prevention

**User Story:** As a system reliability engineer, I want to prevent namespace starvation, so that all namespaces receive fair processing time.

#### Acceptance Criteria

1. WHEN a namespace has not been processed for an extended period, THE System SHALL prioritize it in the next scheduling cycle
2. WHEN starvation is detected, THE System SHALL append a NAMESPACE_STARVATION_DETECTED event with tenant_id, namespace_id, and idle_duration_events
3. WHEN starvation prevention activates, THE System SHALL temporarily boost the starved namespace's scheduling priority
4. WHEN starvation state is queried, THE System SHALL return last_processed_sequence and events_since_last_process per namespace
5. WHEN the system replays events, THE System SHALL reproduce starvation detection and prevention decisions deterministically

### Requirement 11: Throttled Events Metrics

**User Story:** As a DevOps engineer, I want metrics on throttled events per namespace, so that I can monitor and tune quota settings.

#### Acceptance Criteria

1. WHEN events are throttled, THE System SHALL increment a throttled_events counter per namespace
2. WHEN throttle metrics are queried, THE System SHALL return throttled_count, throttle_reason, and last_throttle_sequence per namespace
3. WHEN throttle metrics are collected, THE System SHALL tag them with tenant_id and namespace_id
4. WHEN the system replays events, THE System SHALL rebuild throttle metrics deterministically from throttle events
5. WHEN throttle patterns are analyzed, THE System SHALL support querying throttle events by time range and namespace

### Requirement 12: Rejected Writes Metrics

**User Story:** As a system operator, I want metrics on rejected writes per namespace, so that I can identify namespaces hitting limits.

#### Acceptance Criteria

1. WHEN writes are rejected, THE System SHALL increment a rejected_writes counter per namespace
2. WHEN rejection metrics are queried, THE System SHALL return rejected_count, rejection_reason, and last_rejection_sequence per namespace
3. WHEN rejection metrics are collected, THE System SHALL categorize by rejection_type (quota, rate_limit, cap, backpressure)
4. WHEN the system replays events, THE System SHALL rebuild rejection metrics deterministically from rejection events
5. WHEN rejection patterns are analyzed, THE System SHALL support querying rejection events by namespace and rejection_type

### Requirement 13: Queue Depth Metrics

**User Story:** As a capacity planner, I want queue depth metrics per namespace, so that I can identify namespaces that need more resources.

#### Acceptance Criteria

1. WHEN operations are queued, THE System SHALL track queue_depth per namespace
2. WHEN queue metrics are queried, THE System SHALL return current_depth, max_depth, and average_depth per namespace
3. WHEN queue depth exceeds threshold, THE System SHALL append a NAMESPACE_QUEUE_DEPTH_HIGH event
4. WHEN the system replays events, THE System SHALL rebuild queue depth state deterministically from queue events
5. WHEN queue patterns are analyzed, THE System SHALL support querying queue depth history by namespace

### Requirement 14: Latency Metrics Per Namespace

**User Story:** As a performance engineer, I want latency metrics per namespace, so that I can identify performance issues affecting specific namespaces.

#### Acceptance Criteria

1. WHEN operations complete, THE System SHALL track operation_latency per namespace using event-derived timing
2. WHEN latency metrics are queried, THE System SHALL return p50, p95, p99, and max latency per namespace
3. WHEN latency exceeds threshold, THE System SHALL append a NAMESPACE_LATENCY_HIGH event
4. WHEN latency is measured, THE System SHALL use event sequence differences (not wall-clock time) for replay safety
5. WHEN the system replays events, THE System SHALL rebuild latency metrics deterministically from operation events

### Requirement 15: Replay-Safe Metrics Collection

**User Story:** As a system architect, I want all metrics to be replay-safe, so that replaying events produces identical metric state.

#### Acceptance Criteria

1. WHEN metrics are collected, THE System SHALL derive them from event data only (no wall-clock dependencies)
2. WHEN metrics state is rebuilt, THE System SHALL produce identical values after replay as during live operation
3. WHEN metrics events are stored, THE System SHALL include all data needed for deterministic reconstruction
4. WHEN metrics are queried post-replay, THE System SHALL return values consistent with pre-crash state
5. WHEN metrics collection is verified, THE System SHALL confirm replay produces byte-identical metric snapshots

### Requirement 16: Verification Script Requirements

**User Story:** As a quality engineer, I want a verification script that proves isolation under load, so that I can validate Phase 3B correctness.

#### Acceptance Criteria

1. WHEN verification runs, THE System SHALL create at least 5 namespaces across multiple tenants
2. WHEN verification runs, THE System SHALL flood one namespace with excessive writes while others operate normally
3. WHEN verification completes, THE System SHALL prove non-flooded namespaces were unaffected by the flood
4. WHEN verification runs, THE System SHALL kill the process and replay to verify identical quota and isolation state
5. WHEN verification outputs results, THE System SHALL provide machine-verifiable assertions (not log-only validation)
