# Implementation Plan: Production Docker Deployment

## Overview

This implementation plan creates a fully Dockerized, production-ready real-time system where Frontend ↔ Backend ↔ ShrikDB Engine communicate via WebSockets with verifiable, real data. The approach focuses on creating Docker configurations first, then implementing WebSocket authentication, and finally verifying all production criteria.

## Tasks

- [x] 1. Create ShrikDB Engine Dockerfile
  - [x] 1.1 Create multi-stage Dockerfile for ShrikDB Go binary
    - Use golang:1.21-alpine as builder stage
    - Use alpine:3.19 as production stage
    - Build binary from shrikdb/cmd/shrikdb
    - Expose port 8080
    - Add health check for /health endpoint
    - _Requirements: 1.1, 1.2, 1.3_

  - [x] 1.2 Add health endpoint to ShrikDB if not present
    - Verify /health endpoint exists and returns proper status
    - Include WAL status in health response
    - _Requirements: 1.3_

- [x] 2. Create Unified Backend Dockerfile
  - [x] 2.1 Create Dockerfile for Node.js backend
    - Use node:20-alpine as base
    - Copy package.json and install production dependencies
    - Copy server files and streams directory
    - Expose ports 3001 and 3002
    - Add health check for /api/health endpoint
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 2.2 Update backend to use environment variables for configuration
    - Read SHRIKDB_HOST and SHRIKDB_PORT from environment
    - Read API_PORT and WS_PORT from environment
    - Remove any hardcoded connection strings
    - _Requirements: 2.6_

- [x] 3. Implement WebSocket Authentication
  - [x] 3.1 Add credential validation to WebSocket server
    - Parse client_id and client_key from query parameters
    - Reject with code 4001 if credentials missing
    - Validate credentials against ShrikDB
    - Reject with code 4003 if credentials invalid
    - Accept and send welcome message if valid
    - Log all rejection reasons
    - _Requirements: 5.1, 5.2, 5.3, 5.5_

  - [x] 3.2 Write property test for WebSocket authentication
    - **Property 3: WebSocket Authentication**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.5**

- [x] 4. Implement Backend-to-ShrikDB Event Subscription
  - [x] 4.1 Create event subscriber for ShrikDB events
    - Subscribe to ShrikDB event API
    - Forward events to WebSocket clients
    - Handle ShrikDB disconnection gracefully
    - Implement retry with exponential backoff
    - _Requirements: 8.5, 2.4_

  - [x] 4.2 Write property test for event forwarding
    - **Property 8: Backend-to-Engine Event Forwarding**
    - **Validates: Requirements 8.5**

- [x] 5. Checkpoint - Backend WebSocket Integration
  - Verify WebSocket server accepts authenticated connections
  - Verify events from ShrikDB are forwarded to clients
  - Verify unauthenticated connections are rejected
  - Ask the user if questions arise

- [x] 6. Create Frontend Dockerfile
  - [x] 6.1 Create multi-stage Dockerfile for React frontend
    - Use node:20-alpine as builder stage
    - Build React app with npm run build
    - Use nginx:alpine as production stage
    - Copy built files to nginx html directory
    - Expose port 3000
    - Add health check
    - _Requirements: 3.1, 3.2_

  - [x] 6.2 Create nginx configuration for API and WebSocket proxying
    - Proxy /api/* to backend:3001
    - Proxy /ws/* to backend:3002 with WebSocket upgrade headers
    - Configure SPA fallback for React routing
    - _Requirements: 3.3, 3.4_

- [x] 7. Update Frontend WebSocket Connection
  - [x] 7.1 Add authentication to WebSocket connection
    - Include client_id and client_key in WebSocket URL query params
    - Handle 4001 (missing credentials) error
    - Handle 4003 (invalid credentials) error
    - Display appropriate error messages
    - _Requirements: 5.1, 5.2, 5.3_

  - [x] 7.2 Implement exponential backoff reconnection
    - Start with 1 second delay
    - Double delay on each attempt (max 30 seconds)
    - Limit to 10 automatic reconnection attempts
    - Show manual reconnect button after max attempts
    - _Requirements: 6.1, 6.2, 6.3, 6.5_

  - [x] 7.3 Write property test for reconnection backoff
    - **Property 4: WebSocket Reconnection Backoff**
    - **Validates: Requirements 6.2, 6.3**

  - [x] 7.4 Update connection status display
    - Show "Connected" when WebSocket is open
    - Show "Reconnecting (attempt X/10)" during reconnection
    - Show "Disconnected" with manual reconnect button after max attempts
    - _Requirements: 6.6_

  - [x] 7.5 Write property test for connection status display
    - **Property 12: Connection Status Display**
    - **Validates: Requirements 6.6**

- [x] 8. Checkpoint - Frontend WebSocket Integration
  - Verify frontend connects with authentication
  - Verify reconnection with backoff works
  - Verify connection status displays correctly
  - Ask the user if questions arise

- [x] 9. Create Docker Compose Configuration
  - [x] 9.1 Create docker-compose.yml with all services
    - Define shrikdb service with health check and volume
    - Define backend service with depends_on shrikdb
    - Define frontend service with depends_on backend
    - Create shared network for inter-service communication
    - Use environment variables for all configuration
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x] 9.2 Create .env.docker file for Docker environment
    - Define SHRIKDB_HOST, SHRIKDB_PORT
    - Define API_PORT, WS_PORT
    - Define LOG_LEVEL
    - _Requirements: 4.5_

- [x] 10. Implement Real-Time Data Broadcasting
  - [x] 10.1 Broadcast log entries to WebSocket clients
    - Forward log events from ShrikDB to connected clients
    - Include timestamp, level, service, message
    - _Requirements: 7.1_

  - [x] 10.2 Broadcast metric updates to WebSocket clients
    - Forward metric events from ShrikDB to connected clients
    - Include metric name, value, labels
    - _Requirements: 7.2_

  - [x] 10.3 Broadcast stream events to subscribed clients
    - Forward stream events from ShrikDB to connected clients
    - Include stream name, event_id, payload
    - _Requirements: 7.3_

  - [x] 10.4 Write property test for real-time broadcasting
    - **Property 6: Real-Time Data Broadcasting**
    - **Validates: Requirements 7.1, 7.2, 7.3**

- [x] 11. Implement Data Source Integrity
  - [x] 11.1 Ensure all WebSocket data comes from ShrikDB event log
    - Remove any mock data generation
    - Remove any synthetic data buffering
    - Verify all data has corresponding event log entry
    - _Requirements: 7.4, 8.3_

  - [x] 11.2 Write property test for data source integrity
    - **Property 7: Data Source Integrity**
    - **Validates: Requirements 7.4, 8.3**

- [x] 12. Checkpoint - Real-Time Data Flow
  - Verify logs stream from ShrikDB through WebSocket
  - Verify metrics update when events are appended
  - Verify no mock data is present
  - Ask the user if questions arise

- [x] 13. Implement Service Resilience
  - [x] 13.1 Implement backend retry for ShrikDB connection
    - Retry with exponential backoff when ShrikDB unavailable
    - Log retry attempts
    - Notify WebSocket clients of ShrikDB disconnection
    - _Requirements: 2.4, 7.5_

  - [x] 13.2 Implement WAL state recovery verification
    - Verify ShrikDB recovers state from WAL after restart
    - Verify no data loss after container restart
    - _Requirements: 1.4, 1.6, 10.3_

  - [x] 13.3 Write property test for WAL state recovery
    - **Property 2: WAL State Recovery**
    - **Validates: Requirements 1.4, 1.6, 10.3**

  - [x] 13.4 Write property test for service auto-reconnection
    - **Property 11: Service Auto-Reconnection**
    - **Validates: Requirements 10.1, 10.2**

- [x] 14. Implement Disconnect Detection
  - [x] 14.1 Add disconnect detection to frontend
    - Detect WebSocket close within 5 seconds
    - Display disconnect status immediately
    - _Requirements: 9.4_

  - [x] 14.2 Write property test for disconnect detection timing
    - **Property 9: Disconnect Detection Timing**
    - **Validates: Requirements 9.4**

- [x] 15. Checkpoint - Service Resilience
  - Verify backend reconnects to ShrikDB after restart
  - Verify frontend reconnects to backend after restart
  - Verify state recovers from WAL
  - Ask the user if questions arise

- [x] 16. Create Production Verification Script
  - [x] 16.1 Create verify-production.js script
    - Test WebSocket connects successfully
    - Test logs stream live when backend runs
    - Test metrics change when events are appended
    - Test killing backend shows disconnect in UI
    - Test restarting services restores state
    - Test no 401/500 error loops
    - Test no console errors
    - Test no mock/demo output
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8_

  - [x] 16.2 Write property test for production quality output
    - **Property 10: Production Quality Output**
    - **Validates: Requirements 9.6, 9.7, 9.8**

- [x] 17. Implement Port Availability Verification
  - [x] 17.1 Write property test for service port availability
    - **Property 1: Service Port Availability**
    - **Validates: Requirements 1.2, 2.2, 3.2**

- [x] 18. Implement Reconnection Data Resume
  - [x] 18.1 Ensure data resumes after WebSocket reconnection
    - Resume receiving logs after reconnection
    - Resume receiving metrics after reconnection
    - Resume receiving stream events after reconnection
    - _Requirements: 6.4_

  - [x] 18.2 Write property test for reconnection data resume
    - **Property 5: WebSocket Reconnection Data Resume**
    - **Validates: Requirements 6.1, 6.4**

- [x] 19. Final Integration Testing
  - [x] 19.1 Run docker-compose up and verify all services start
    - Verify ShrikDB starts and is healthy
    - Verify Backend starts and connects to ShrikDB
    - Verify Frontend starts and serves static files
    - _Requirements: 4.2, 10.4, 10.5_

  - [x] 19.2 Run production verification script
    - Execute verify-production.js
    - Verify all 8 criteria pass
    - Generate verification report
    - _Requirements: 9.1-9.8_

- [x] 20. Final Checkpoint - Production Ready
  - All Docker containers build successfully
  - All services start in correct order
  - WebSocket authentication works
  - Real-time data streams from ShrikDB
  - Reconnection with backoff works
  - State recovers after restarts
  - All verification criteria pass
  - Ask the user if questions arise

## Notes

- All tasks are required for production-ready deployment
- Property tests use fast-check for TypeScript tests
- Integration tests run against real Docker containers (no mocks)
- All data must come from ShrikDB event log (no mock data)
- WebSocket authentication reuses existing client_id/client_key mechanism
- Environment variables used for all configuration (no hardcoded secrets)
