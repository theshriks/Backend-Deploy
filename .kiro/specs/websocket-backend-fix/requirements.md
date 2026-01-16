# Requirements Document

## Introduction

This document specifies the requirements for fixing the WebSocket log stream backend connectivity issue. The Ops UI correctly shows a real backend connectivity failure - the WebSocket server on port 3002 is not running or not reachable. This spec addresses ensuring the WebSocket backend is properly started and integrated with the service orchestration.

## Glossary

- **WebSocket_Server**: The real-time log streaming server running on port 3002 at path `/ws/logs`
- **Ops_UI**: The observability dashboard that displays real-time logs, metrics, and service health
- **Service_Orchestrator**: The component responsible for starting services in dependency order with health checks
- **Unified_Backend**: The main API server running on port 3001 that integrates with ShrikDB

## Requirements

### Requirement 1: WebSocket Server Startup

**User Story:** As a developer, I want the WebSocket server to start automatically with the backend services, so that the Ops UI can receive real-time logs.

#### Acceptance Criteria

1. WHEN the unified backend starts THEN the WebSocket_Server SHALL start on port 3002 at path `/ws/logs`
2. WHEN the WebSocket_Server starts successfully THEN the system SHALL log a confirmation message
3. IF the WebSocket_Server fails to start THEN the system SHALL log an error with the failure reason
4. WHEN port 3002 is already in use THEN the system SHALL report the port conflict clearly

### Requirement 2: Service Orchestration Integration

**User Story:** As a developer, I want the WebSocket server health to be verified during service startup, so that I know the real-time logging is available.

#### Acceptance Criteria

1. WHEN the Service_Orchestrator starts the unified backend THEN it SHALL verify WebSocket connectivity at `ws://localhost:3002/ws/logs`
2. WHEN the WebSocket health check passes THEN the Service_Orchestrator SHALL report the WebSocket server as healthy
3. IF the WebSocket health check fails THEN the Service_Orchestrator SHALL report the failure and continue with a warning

### Requirement 3: Health Status Reporting

**User Story:** As a developer, I want the health endpoint to accurately report WebSocket server status, so that I can diagnose connectivity issues.

#### Acceptance Criteria

1. WHEN the `/api/recovery/status` endpoint is called THEN the response SHALL include accurate WebSocket server status
2. WHEN the WebSocket_Server is running THEN the health status SHALL show `status: "healthy"` and `port: 3002`
3. WHEN the WebSocket_Server is not running THEN the health status SHALL show `status: "unavailable"`

### Requirement 4: Connection Diagnostics

**User Story:** As a developer, I want clear diagnostic information when WebSocket connections fail, so that I can quickly identify and fix issues.

#### Acceptance Criteria

1. WHEN a WebSocket connection attempt fails THEN the system SHALL provide the specific error reason
2. WHEN the WebSocket_Server is not reachable THEN the Ops_UI SHALL display "WebSocket disconnected" with reconnection status
3. WHEN reconnection attempts are exhausted THEN the Ops_UI SHALL display "Connection Failed" with a manual reconnect option
