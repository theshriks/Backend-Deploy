# Implementation Plan: Ops Observability UI

## Overview

This implementation plan adds a minimal Ops/Observability panel to the existing ShrikDB frontend. The implementation reuses existing patterns from Monitoring.tsx and integrates with existing backend APIs and WebSocket infrastructure. All tasks focus on displaying real data only — no mocks, no simulations.

## Tasks

- [x] 1. Add Ops view to frontend routing
  - [x] 1.1 Add OPS enum value to View enum in types.ts
    - Add `OPS = 'Ops'` to the View enum
    - _Requirements: 1.1_
  - [x] 1.2 Update App.tsx to import and route to Ops page
    - Import Ops component
    - Add case for View.OPS in renderContent switch
    - _Requirements: 1.1_
  - [x] 1.3 Update Layout component to include Ops navigation item
    - Add Ops link to sidebar navigation
    - _Requirements: 1.1_

- [x] 2. Create Ops page component with log streaming
  - [x] 2.1 Create pages/Ops.tsx with WebSocket connection
    - Implement WebSocket connection to ws://localhost:3002/ws/logs
    - Handle connection, message, close, and error events
    - Implement exponential backoff reconnection
    - _Requirements: 1.1, 1.7_
  - [x] 2.2 Implement log buffer with 1000 entry limit
    - Maintain logs array state with FIFO eviction
    - Display logs in scrollable container
    - _Requirements: 1.8_
  - [x] 2.3 Write property test for log buffer size constraint
    - **Property 3: Log Buffer Size Constraint**
    - **Validates: Requirements 1.8**
  - [x] 2.4 Implement log entry rendering with all required fields
    - Display timestamp, service, level, message, correlation_id
    - Apply visual styling based on log level
    - _Requirements: 1.6, 4.2_
  - [x] 2.5 Write property test for log entry completeness
    - **Property 2: Log Entry Completeness**
    - **Validates: Requirements 1.6**

- [x] 3. Implement log filtering
  - [x] 3.1 Add service filter dropdown
    - Filter options: all, api, wal, replay, worker, system
    - Apply filter to displayed logs
    - _Requirements: 1.4_
  - [x] 3.2 Add log level filter dropdown
    - Filter options: all, error, warn, info, debug
    - Apply filter to displayed logs
    - _Requirements: 1.5_
  - [x] 3.3 Write property test for log filtering correctness
    - **Property 1: Log Filtering Correctness**
    - **Validates: Requirements 1.4, 1.5, 4.6**

- [x] 4. Checkpoint - Log streaming working
  - Verify WebSocket connects and receives logs
  - Verify filters work correctly
  - Verify buffer limit is enforced

- [x] 5. Implement health status panel
  - [x] 5.1 Create HealthPanel component
    - Fetch from /api/recovery/status endpoint
    - Display ShrikDB, Unified Backend, WebSocket status
    - Show uptime and connection state
    - _Requirements: 2.1, 2.2, 2.3_
  - [x] 5.2 Implement status indicators with visual styling
    - Green for healthy/connected
    - Yellow for degraded/connecting
    - Red for unavailable/error
    - _Requirements: 2.6_
  - [x] 5.3 Display reconnect capabilities
    - Show ShrikDB reconnect, WebSocket reconnect, exponential backoff status
    - _Requirements: 2.5_
  - [x] 5.4 Write property test for health status data binding
    - **Property 6: Health Status Data Binding**
    - **Validates: Requirements 2.2, 2.6**

- [x] 6. Implement metrics panel
  - [x] 6.1 Create MetricsPanel component
    - Fetch from /api/metrics endpoint
    - Display event append rate, latency p50/p95
    - Display storage usage, request counts
    - _Requirements: 3.1, 3.2, 3.3, 3.5_
  - [x] 6.2 Implement periodic refresh
    - Default 5 second interval
    - Show last updated timestamp
    - _Requirements: 3.6_
  - [x] 6.3 Implement error state handling
    - Display zeros on fetch failure
    - Show error indicator
    - _Requirements: 3.7_
  - [x] 6.4 Write property test for metrics data binding
    - **Property 5: Metrics Data Binding**
    - **Validates: Requirements 3.1, 3.7**
  - [x] 6.5 Write property test for error state handling
    - **Property 7: Error State Handling**
    - **Validates: Requirements 3.7, 10.3**

- [x] 7. Implement worker metrics display
  - [x] 7.1 Fetch and display worker activity
    - Fetch from /api/workers and /api/workers/metrics
    - Display active worker count, events processed
    - _Requirements: 3.4, 8.1, 8.4_
  - [x] 7.2 Display partition assignments
    - Fetch from /api/partitions
    - Show partition distribution across workers
    - _Requirements: 8.2, 8.5_

- [x] 8. Checkpoint - Health and metrics working
  - Verify health status displays correctly
  - Verify metrics refresh periodically
  - Verify worker/partition data displays

- [x] 9. Implement error and warning panel
  - [x] 9.1 Create ErrorPanel component
    - Filter logs by error/warn level
    - Display in dedicated panel
    - _Requirements: 4.1_
  - [x] 9.2 Fetch and display security violations
    - Fetch from /api/security/violations
    - Display violation type, tenant, reason
    - _Requirements: 4.4_
  - [x] 9.3 Implement error/warning filter toggle
    - Allow filtering to show only errors or only warnings
    - _Requirements: 4.6_
  - [x] 9.4 Write property test for error visual distinction
    - **Property 11: Error Visual Distinction**
    - **Validates: Requirements 4.2**

- [x] 10. Implement benchmark results panel
  - [x] 10.1 Create BenchmarkPanel component
    - Parse benchmark JSON files from workspace
    - Display append latency, read latency, throughput
    - _Requirements: 5.2, 5.3_
  - [x] 10.2 Display benchmark timestamps
    - Show when each benchmark was run
    - _Requirements: 5.4_
  - [x] 10.3 Implement empty state
    - Display "No benchmark data available" when no data
    - _Requirements: 5.5_
  - [x] 10.4 Write property test for benchmark data consistency
    - **Property 10: Benchmark Data Consistency**
    - **Validates: Requirements 5.2, 11.4**

- [x] 11. Implement project and tenant filtering
  - [x] 11.1 Add project filter dropdown
    - Populate from actual projects
    - Filter logs and metrics by project
    - _Requirements: 6.1, 6.3_
  - [x] 11.2 Add tenant filter dropdown
    - Populate from actual tenants
    - Filter logs and metrics by tenant
    - _Requirements: 6.2, 6.4_
  - [x] 11.3 Fetch tenant-specific metrics
    - Call /api/tenants/:tenantId/namespaces/:namespaceId/metrics
    - Display tenant-specific data
    - _Requirements: 6.5_
  - [x] 11.4 Write property test for project/tenant filter correctness
    - **Property 8: Project/Tenant Filter Correctness**
    - **Validates: Requirements 6.3, 6.4**

- [x] 12. Implement replay and recovery display
  - [x] 12.1 Display last replay information
    - Show timestamp, success status, events processed
    - Show replay duration
    - _Requirements: 7.1, 7.3, 7.4_
  - [x] 12.2 Display recovery verification results
    - Show verification test results when available
    - _Requirements: 7.5_

- [x] 13. Checkpoint - All panels working
  - Verify error panel displays correctly
  - Verify benchmark panel shows real data or empty state
  - Verify filters work across all panels

- [x] 14. Enforce read-only constraint
  - [x] 14.1 Audit component for mutation controls
    - Remove any POST/PUT/DELETE buttons
    - Ensure all API calls are GET only
    - _Requirements: 9.1, 9.2, 9.3_
  - [x] 14.2 Make all data displays read-only
    - No editable input fields
    - No form submissions
    - _Requirements: 9.4_
  - [x] 14.3 Write property test for read-only constraint
    - **Property 9: Read-Only Constraint**
    - **Validates: Requirements 9.1, 9.2, 9.3, 9.4**

- [x] 15. Implement WebSocket reconnection with backoff
  - [x] 15.1 Implement exponential backoff logic
    - Base delay 1 second, max delay 32 seconds
    - Add jitter to prevent thundering herd
    - _Requirements: 1.7_
  - [x] 15.2 Display connection status
    - Show connected/disconnected/connecting/error state
    - Show reconnection attempt count
    - _Requirements: 1.7_
  - [x] 15.3 Write property test for reconnection backoff
    - **Property 4: WebSocket Reconnection Backoff**
    - **Validates: Requirements 1.7**

- [x] 16. Final checkpoint - Complete verification
  - Kill and restart a service → verify logs reflect it
  - Append events → verify metrics change
  - Trigger replay → verify replay logs appear
  - Verify benchmarks match backend output files
  - _Requirements: 11.1, 11.2, 11.3, 11.4_

## Notes

- All tasks including property-based tests are required
- All data must come from existing APIs - no mock data generation
- Reuse patterns from existing Monitoring.tsx where applicable
- Property tests use fast-check library with minimum 100 iterations
- Each property test references specific design document property
