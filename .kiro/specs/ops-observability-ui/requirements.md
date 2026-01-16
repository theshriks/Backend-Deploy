# Requirements Document

## Introduction

This document specifies requirements for a minimal internal Ops/Observability UI panel integrated into the existing ShrikDB frontend. The panel exposes real system state only — logs, benchmarks, errors, and health — with no mocks, no simulations, and no fake data. The UI is read-only and consumes existing APIs and log streams.

## Glossary

- **Ops_UI**: The internal observability panel that displays real system state
- **Log_Stream**: Real-time structured log data from backend services via WebSocket
- **Metrics_API**: Backend endpoints that return actual system metrics from ShrikDB
- **WAL**: Write-Ahead Log, the persistent event storage in ShrikDB
- **Replay**: The process of reconstructing state from WAL events
- **Worker**: Background processing units that handle partitioned workloads
- **Backpressure**: Flow control mechanism when system is overloaded
- **Tenant**: An isolated customer/project namespace in the multi-tenant system

## Requirements

### Requirement 1: Real-Time Log Streaming

**User Story:** As an operator, I want to view live structured logs from all backend services, so that I can monitor system behavior in real-time.

#### Acceptance Criteria

1. WHEN the Ops_UI loads, THE Log_Stream SHALL connect to the WebSocket server on port 3002
2. WHEN a log event is received via WebSocket, THE Ops_UI SHALL display it within 100ms
3. THE Ops_UI SHALL display logs from API, WAL, Replay, and Worker services
4. WHEN filtering by service is applied, THE Ops_UI SHALL show only logs from the selected service
5. WHEN filtering by log level is applied, THE Ops_UI SHALL show only logs matching the selected level (error, warn, info, debug)
6. THE Ops_UI SHALL display log timestamp, service, level, message, and correlation_id for each entry
7. IF the WebSocket connection is lost, THEN THE Ops_UI SHALL attempt reconnection with exponential backoff
8. THE Ops_UI SHALL maintain a scrollable log buffer of the last 1000 entries

### Requirement 2: System Health Dashboard

**User Story:** As an operator, I want to see current system health status, so that I can quickly identify service issues.

#### Acceptance Criteria

1. THE Ops_UI SHALL display health status for ShrikDB Core, Unified Backend, and WebSocket Server
2. WHEN the /api/recovery/status endpoint returns data, THE Ops_UI SHALL display the actual service states
3. THE Ops_UI SHALL show service uptime from real backend data
4. WHEN a service status changes, THE Ops_UI SHALL reflect the change within 10 seconds
5. THE Ops_UI SHALL display reconnect capability status (ShrikDB reconnect, WebSocket reconnect, exponential backoff)
6. IF a service is unavailable, THEN THE Ops_UI SHALL display the error state with appropriate visual indicator

### Requirement 3: Real-Time Metrics Display

**User Story:** As an operator, I want to view actual system metrics, so that I can monitor performance and throughput.

#### Acceptance Criteria

1. WHEN the /api/metrics endpoint returns data, THE Ops_UI SHALL display the actual metrics values
2. THE Ops_UI SHALL display event append rate (events per second) from real data
3. THE Ops_UI SHALL display API latency percentiles (p50, p95) from actual request tracking
4. THE Ops_UI SHALL display worker activity metrics from the /api/workers/metrics endpoint
5. THE Ops_UI SHALL display storage usage from actual WAL bytes written
6. THE Ops_UI SHALL refresh metrics at a configurable interval (default 5 seconds)
7. IF metrics fetch fails, THEN THE Ops_UI SHALL display zeros with an error indicator, not mock data

### Requirement 4: Error and Warning Surface

**User Story:** As an operator, I want to see errors, warnings, and slow operations, so that I can identify and troubleshoot issues.

#### Acceptance Criteria

1. THE Ops_UI SHALL display a dedicated errors/warnings panel filtering logs by level
2. WHEN an error log is received, THE Ops_UI SHALL highlight it with visual distinction
3. THE Ops_UI SHALL display error count from actual /api/metrics errorCount field
4. THE Ops_UI SHALL display security violations from /api/security/violations endpoint
5. WHEN a slow operation is detected (latency > p95), THE Ops_UI SHALL flag it in the logs
6. THE Ops_UI SHALL allow filtering to show only errors or only warnings

### Requirement 5: Benchmark Results Display

**User Story:** As an operator, I want to view actual benchmark results, so that I can assess system performance.

#### Acceptance Criteria

1. THE Ops_UI SHALL display benchmark results only from stored/generated real runs
2. WHEN benchmark JSON files exist in the workspace, THE Ops_UI SHALL parse and display them
3. THE Ops_UI SHALL display append latency, read latency, and throughput from real benchmarks
4. THE Ops_UI SHALL display the timestamp of when each benchmark was run
5. IF no benchmark data exists, THEN THE Ops_UI SHALL display "No benchmark data available" message

### Requirement 6: Project and Tenant Filtering

**User Story:** As an operator, I want to filter observability data by project and tenant, so that I can focus on specific workloads.

#### Acceptance Criteria

1. THE Ops_UI SHALL provide a project filter dropdown populated from actual projects
2. THE Ops_UI SHALL provide a tenant filter dropdown populated from actual tenants
3. WHEN a project filter is selected, THE Ops_UI SHALL filter logs and metrics to that project
4. WHEN a tenant filter is selected, THE Ops_UI SHALL filter logs and metrics to that tenant
5. THE Ops_UI SHALL display tenant-specific metrics from /api/tenants/:tenantId/namespaces/:namespaceId/metrics

### Requirement 7: Replay and Recovery Monitoring

**User Story:** As an operator, I want to monitor replay operations and recovery status, so that I can verify system integrity.

#### Acceptance Criteria

1. THE Ops_UI SHALL display last replay timestamp and status from /api/recovery/status
2. WHEN a replay is triggered, THE Ops_UI SHALL show replay progress in real-time via logs
3. THE Ops_UI SHALL display replay duration from actual replay operations
4. THE Ops_UI SHALL display events processed count from replay results
5. WHEN recovery verification is run, THE Ops_UI SHALL display verification results

### Requirement 8: Worker and Partition Monitoring

**User Story:** As an operator, I want to monitor worker status and partition assignments, so that I can verify horizontal scaling.

#### Acceptance Criteria

1. THE Ops_UI SHALL display active worker count from /api/workers endpoint
2. THE Ops_UI SHALL display partition assignments from /api/partitions endpoint
3. WHEN worker status changes, THE Ops_UI SHALL reflect the change via WebSocket updates
4. THE Ops_UI SHALL display events processed per worker from actual metrics
5. THE Ops_UI SHALL display partition distribution across workers

### Requirement 9: Read-Only Constraint

**User Story:** As an operator, I want the Ops UI to be read-only, so that I cannot accidentally mutate system state.

#### Acceptance Criteria

1. THE Ops_UI SHALL NOT provide any buttons or forms that mutate system state
2. THE Ops_UI SHALL only call GET endpoints for data retrieval
3. THE Ops_UI SHALL NOT include create, update, or delete operations
4. THE Ops_UI SHALL display data in read-only format without editable fields

### Requirement 10: No Mock Data Constraint

**User Story:** As an operator, I want to see only real data, so that I can trust the observability information.

#### Acceptance Criteria

1. THE Ops_UI SHALL NOT generate or display mock/demo data
2. THE Ops_UI SHALL NOT use client-side fake state
3. WHEN backend data is unavailable, THE Ops_UI SHALL display "Data unavailable" or zeros
4. THE Ops_UI SHALL consume only existing APIs and log streams
5. THE Ops_UI SHALL NOT create synthetic metrics or logs

### Requirement 11: Verification Support

**User Story:** As an operator, I want to verify that the UI reflects real system state, so that I can trust the data.

#### Acceptance Criteria

1. WHEN a service is killed and restarted, THE Ops_UI logs SHALL reflect the service restart
2. WHEN events are appended, THE Ops_UI metrics SHALL show increased event count
3. WHEN replay is triggered, THE Ops_UI SHALL show replay logs appearing
4. THE Ops_UI benchmark display SHALL match backend benchmark output files
