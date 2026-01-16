# Implementation Plan: ShrikDB Phase 4B - Production Hardening

## Overview

This implementation plan transforms ShrikDB into a production-grade system by eliminating all mocks, ensuring all writes flow through the WAL, adding minimal diagnostic UI, and providing comprehensive verification. The implementation follows a strict order: backend hardening first, then frontend enhancements, then verification, and finally Docker packaging.

## Tasks

- [ ] 1. Backend: Eliminate Mocks and Enforce WAL-Only Writes
  - Remove any mock data generation in unified-backend-api.js
  - Ensure all document/stream operations call ShrikDB AppendEvent API
  - Verify no bypass paths exist (no local state, no shadow databases)
  - Add validation that all responses come from ShrikDB (not hardcoded)
  - _Requirements: 1.1, 1.2, 1.3, 2.2, 16.2_

- [ ] 1.1 Write property test for WAL-only writes
  - **Property 1: All Writes Through WAL**
  - **Validates: Requirements 1.1, 1.3, 2.1**

- [ ] 1.2 Write property test for no bypass paths
  - **Property 2: No Bypass Paths**
  - **Validates: Requirements 1.2, 2.2**

- [ ] 2. Backend: Enhance Latency Tracking and Real Metrics
  - Verify LatencyTracker is recording append/read latencies correctly
  - Ensure metrics endpoint returns real data from ShrikDB (not mock)
  - Add real-time throughput calculation (events in 5-second window)
  - Remove any hardcoded or placeholder metric values
  - _Requirements: 7.1, 7.2, 7.3, 9.1, 9.2, 13.1_

- [ ] 2.1 Write property test for real metrics calculation
  - **Property 13: Real Metrics Calculation**
  - **Validates: Requirements 7.1, 7.2, 7.3, 9.1, 9.2, 9.3, 9.4**

- [ ] 3. Backend: Enhance WebSocket Real-Time Event Broadcasting
  - Ensure WebSocket broadcasts real WAL events (not simulated)
  - Add event broadcasting on every AppendEvent call
  - Verify WebSocket messages match WAL events exactly
  - Implement reconnection resume from last sequence number
  - _Requirements: 4.1, 4.2, 4.4, 16.3_

- [ ] 3.1 Write property test for WebSocket real-time delivery
  - **Property 7: Real-Time WebSocket Delivery**
  - **Validates: Requirements 4.1, 4.2, 4.4, 16.3**

- [ ] 3.2 Write property test for WebSocket reconnection resume
  - **Property 8: WebSocket Reconnection Resume**
  - **Validates: Requirements 4.4**

- [ ] 4. Backend: Add Replay and Recovery Endpoints
  - Implement POST /api/replay endpoint (proxy to ShrikDB)
  - Implement GET /api/recovery/status endpoint
  - Implement POST /api/recovery/verify endpoint
  - Add replay progress tracking and broadcasting via WebSocket
  - _Requirements: 5.1, 5.4, 5.5, 10.4, 10.5_

- [ ] 4.1 Write property test for deterministic replay
  - **Property 3: Deterministic Replay**
  - **Validates: Requirements 1.4, 5.1, 5.2, 5.3, 11.2, 19.1, 20.2**

- [ ] 4.2 Write property test for replay progress observability
  - **Property 11: Replay Progress Observability**
  - **Validates: Requirements 5.4, 5.5**

- [ ] 5. Frontend: Create Event Log Viewer Component
  - Create new EventLogViewer.tsx component
  - Display events with sequence number, event type, project_id, timestamp
  - Connect to WebSocket for real-time event updates
  - Add filtering by project/tenant/namespace
  - Make it read-only (no write buttons)
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

- [ ] 5.1 Write property test for event display completeness
  - **Property 10: Event Display Completeness**
  - **Validates: Requirements 4.3, 6.1, 6.3**

- [ ] 5.2 Write property test for projection filtering
  - **Property 12: Projection Filtering**
  - **Validates: Requirements 6.5**

- [ ] 6. Frontend: Enhance Metrics Panel
  - Update Metrics Panel to show real throughput (events/sec)
  - Display append latency (P50/P99) from backend
  - Display read latency (P50/P99) from backend
  - Display replay speed during replay operations
  - Display worker/partition status if available
  - Remove all hardcoded/mock metric values
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 16.1, 16.4_

- [ ] 6.1 Write property test for no fake activity
  - **Property 9: No Fake Activity**
  - **Validates: Requirements 4.5, 16.1, 16.2, 16.4**

- [ ] 7. Frontend: Create Health Panel Component
  - Create new HealthPanel.tsx component
  - Display authentication failures from backend
  - Display quota violations from backend
  - Display replay errors from backend
  - Display service health indicators (ShrikDB, Backend, WebSocket)
  - Show connection status (connected/disconnected)
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [ ] 7.1 Write property test for error observability
  - **Property 14: Error Observability**
  - **Validates: Requirements 8.1, 8.2, 8.3**

- [ ] 8. Frontend: Add Ops Page with Diagnostic UI
  - Create or enhance Ops.tsx page
  - Integrate EventLogViewer component
  - Integrate enhanced Metrics Panel
  - Integrate Health Panel
  - Ensure all data is real (no mocks)
  - Make entire page read-only
  - _Requirements: 17.1, 17.4_

- [ ] 9. Frontend: Remove All Mock Data
  - Audit all components for hardcoded/mock values
  - Remove mock data from Dashboard, Documents, Streams pages
  - Ensure all data comes from backend API calls
  - Display "No data" when no real data exists (not fake data)
  - _Requirements: 16.1, 16.5_

- [ ] 10. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 11. ShrikDB Core: Verify Sequence Monotonicity
  - Audit WAL append logic to ensure monotonic sequence numbers
  - Add sequence gap detection during replay
  - Log errors when gaps or duplicates are detected
  - Ensure verification confirms no gaps/duplicates
  - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5_

- [ ] 11.1 Write property test for sequence monotonicity
  - **Property 24: Sequence Monotonicity**
  - **Validates: Requirements 18.1, 18.2, 18.3, 18.4, 18.5, 10.5, 14.5**

- [ ] 12. ShrikDB Core: Enhance Replay Engine
  - Ensure replay rebuilds all projections from sequence 0
  - Verify replay produces identical state every time
  - Add replay progress reporting
  - Add error logging with failing sequence numbers
  - _Requirements: 5.1, 5.2, 5.3, 5.5_

- [ ] 12.1 Write property test for state consistency after replay
  - **Property 25: State Consistency After Replay**
  - **Validates: Requirements 19.2, 19.3, 19.4, 19.5**

- [ ] 12.2 Write property test for complete replay coverage
  - **Property 26: Complete Replay Coverage**
  - **Validates: Requirements 20.3, 20.4, 20.5**

- [ ] 13. ShrikDB Core: Verify Tenant Isolation
  - Audit tenant isolation logic in WAL append
  - Ensure cross-tenant access is rejected with 403
  - Add security violation logging
  - Verify tenant filtering in read operations
  - _Requirements: 3.3, 3.4, 12.1_

- [ ] 13.1 Write property test for tenant isolation
  - **Property 5: Tenant Isolation**
  - **Validates: Requirements 3.3, 3.4**

- [ ] 14. Backend: Verify Authentication from WAL
  - Ensure credentials are validated against ShrikDB (not local cache)
  - Add correlation IDs to all auth failure logs
  - Remove any local credential caching
  - _Requirements: 3.1, 3.2, 3.5_

- [ ] 14.1 Write property test for authentication from WAL
  - **Property 6: Authentication from WAL**
  - **Validates: Requirements 3.1, 3.2, 3.5**

- [ ] 15. Backend: Implement Exactly-Once Processing
  - Add duplicate event detection in projection engine
  - Reject duplicate events with error
  - Ensure replay produces exactly-once semantics
  - Add violation logging
  - _Requirements: 11.1, 11.3, 11.5_

- [ ] 15.1 Write property test for exactly-once processing
  - **Property 15: Exactly-Once Processing**
  - **Validates: Requirements 11.1, 11.3, 11.5**

- [ ] 16. Backend: Implement Checkpoint Recovery
  - Add checkpoint tracking during event processing
  - Implement resume from last checkpoint on interruption
  - Ensure no duplicate or lost events during recovery
  - _Requirements: 11.4_

- [ ] 16.1 Write property test for checkpoint recovery
  - **Property 16: Checkpoint Recovery**
  - **Validates: Requirements 11.4**

- [ ] 17. Backend: Verify Backpressure Correctness
  - Audit backpressure logic in QuotaManager
  - Ensure backpressure maintains data integrity and ordering
  - Verify no crashes under backpressure
  - Add backpressure metrics logging
  - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_

- [ ] 17.1 Write property test for backpressure correctness
  - **Property 17: Backpressure Correctness**
  - **Validates: Requirements 12.1, 12.2, 12.5**

- [ ] 17.2 Write property test for backpressure release
  - **Property 18: Backpressure Release**
  - **Validates: Requirements 12.3, 12.4**

- [ ] 18. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 19. Docker: Create Dockerfile for ShrikDB Core
  - Create shrikdb/Dockerfile
  - Build Go binary from source
  - Expose port 8080
  - Add health check endpoint
  - Configure data volume for WAL persistence
  - _Requirements: 13.1, 13.4_

- [ ] 20. Docker: Create Dockerfile for Backend
  - Create Dockerfile.backend
  - Install Node.js dependencies
  - Expose ports 3001 (HTTP) and 3002 (WebSocket)
  - Add health check endpoint
  - Configure environment variables
  - _Requirements: 13.1_

- [ ] 21. Docker: Create Dockerfile for Frontend
  - Create Dockerfile.frontend
  - Build React app
  - Serve via nginx
  - Configure nginx to proxy API and WebSocket requests
  - Expose port 3000
  - _Requirements: 13.1_

- [ ] 22. Docker: Create docker-compose.yml
  - Define services: shrikdb, backend, frontend
  - Configure startup order with depends_on and health checks
  - Define shared network
  - Configure volumes for WAL persistence
  - Add environment variables
  - _Requirements: 13.2, 13.3, 13.5_

- [ ] 22.1 Write property test for container orchestration
  - **Property 19: Container Orchestration**
  - **Validates: Requirements 13.2, 13.3, 13.5**

- [ ] 22.2 Write property test for WAL data persistence
  - **Property 20: WAL Data Persistence**
  - **Validates: Requirements 13.4**

- [ ] 23. Verification: Create End-to-End Verification Script
  - Create verify-phase4b.js script
  - Implement project/account creation
  - Implement event append and read verification
  - Implement WebSocket delivery verification
  - Implement replay verification (sequence monotonicity, state consistency)
  - Output results in JSON format
  - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5_

- [ ] 23.1 Write property test for end-to-end write verification
  - **Property 21: End-to-End Write Verification**
  - **Validates: Requirements 14.2, 14.3**

- [ ] 24. Verification: Add Performance Measurement
  - Measure append throughput (events/sec)
  - Measure read latency (P50/P99)
  - Measure replay speed (events/sec)
  - Measure WebSocket delivery latency
  - Report real numbers (not simulated)
  - _Requirements: 15.4_

- [ ] 24.1 Write property test for verification performance reporting
  - **Property 22: Verification Performance Reporting**
  - **Validates: Requirements 15.4**

- [ ] 25. Verification: Add Logging and Reporting
  - Add timestamps to all verification logs
  - Add correlation IDs to all verification operations
  - Generate JSON report with pass/fail for each test
  - Include error details for failed tests
  - _Requirements: 15.1, 15.2, 15.3, 15.5_

- [ ] 25.1 Write property test for verification logging
  - **Property 23: Verification Logging**
  - **Validates: Requirements 15.5**

- [ ] 26. Integration: Test Crash Recovery
  - Test ShrikDB crash and restart (verify WAL recovery)
  - Test Backend crash and restart (verify reconnection)
  - Test Frontend crash and restart (verify state restoration)
  - Verify no data loss after recovery
  - _Requirements: 10.1, 10.2, 10.3, 10.4_

- [ ] 26.1 Write property test for crash recovery
  - **Property 4: Crash Recovery**
  - **Validates: Requirements 1.5, 2.5, 10.1, 10.2, 10.3, 10.4, 20.1**

- [ ] 27. Integration: Run Full Verification Script
  - Run verify-phase4b.js against running system
  - Verify all tests pass
  - Review performance metrics
  - Confirm no data loss, no sequence gaps, no mocks
  - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 15.1, 15.2, 15.3, 15.4, 15.5_

- [ ] 28. Documentation: Update README with Phase 4B Details
  - Document production-grade features
  - Document Docker deployment instructions
  - Document verification script usage
  - Document performance benchmarks
  - Document no-mock guarantee

- [ ] 29. Final Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- All tasks are required for comprehensive production hardening
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties
- Unit tests validate specific examples and edge cases
- The implementation order ensures backend is hardened before frontend enhancements
- Docker packaging comes last to ensure all components are production-ready
- Verification script provides machine-verifiable proof of correctness
