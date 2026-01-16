# Requirements Document

## Introduction

This document specifies the requirements for containerizing the ShrikDB full-stack system (Frontend, Backend, ShrikDB Engine) using Docker for production deployment. The system must support real-time WebSocket communication with authenticated endpoints, zero mock data, zero silent failures, and verifiable end-to-end data flow from Frontend through Backend to the ShrikDB Engine.

## Glossary

- **ShrikDB_Engine**: The Go-based event-sourced database engine running on port 8080
- **Unified_Backend**: The Node.js API layer on port 3001 that routes requests to ShrikDB and provides WebSocket endpoints
- **WebSocket_Server**: Real-time streaming server integrated with Unified_Backend on port 3002
- **Frontend_App**: React dashboard application served as static files on port 3000
- **Docker_Compose**: Container orchestration tool for defining and running multi-container applications
- **Health_Check**: Endpoint or probe that verifies a service is operational
- **WAL**: Write-Ahead Log, the append-only event store in ShrikDB
- **Backoff**: Reconnection strategy that increases delay between retry attempts

## Requirements

### Requirement 1: ShrikDB Engine Container

**User Story:** As a DevOps engineer, I want the ShrikDB engine containerized, so that I can deploy it consistently across environments.

#### Acceptance Criteria

1. THE Dockerfile SHALL build the ShrikDB Go binary from source
2. WHEN the container starts, THE ShrikDB_Engine SHALL listen on port 8080
3. THE container SHALL expose a health check endpoint at `/health`
4. WHEN the container restarts, THE ShrikDB_Engine SHALL recover state from the WAL
5. THE container SHALL NOT include any mock data or test fixtures
6. WHEN the WAL directory is mounted as a volume, THE ShrikDB_Engine SHALL persist data across container restarts

### Requirement 2: Unified Backend Container

**User Story:** As a DevOps engineer, I want the unified backend containerized with WebSocket support, so that I can deploy the API layer consistently.

#### Acceptance Criteria

1. THE Dockerfile SHALL build the Node.js backend with all dependencies
2. WHEN the container starts, THE Unified_Backend SHALL listen on port 3001 for HTTP and port 3002 for WebSocket
3. THE container SHALL expose a health check endpoint at `/api/health`
4. WHEN ShrikDB_Engine is unavailable, THE Unified_Backend SHALL retry with exponential backoff
5. THE container SHALL NOT bypass authentication for any endpoint
6. WHEN environment variables are provided, THE Unified_Backend SHALL use them for configuration (no hardcoded secrets)

### Requirement 3: Frontend Container

**User Story:** As a DevOps engineer, I want the frontend containerized as a static build, so that I can deploy it efficiently.

#### Acceptance Criteria

1. THE Dockerfile SHALL build the React frontend and serve it via nginx
2. WHEN the container starts, THE Frontend_App SHALL be accessible on port 3000
3. THE container SHALL configure nginx to proxy API requests to Unified_Backend
4. THE container SHALL configure nginx to proxy WebSocket requests to WebSocket_Server
5. THE Frontend_App SHALL NOT contain any hardcoded mock data
6. WHEN the backend is unavailable, THE Frontend_App SHALL display clear error messages

### Requirement 4: Docker Compose Orchestration

**User Story:** As a DevOps engineer, I want a docker-compose configuration that starts all services in the correct order, so that the system works reliably.

#### Acceptance Criteria

1. THE docker-compose.yml SHALL define services for ShrikDB_Engine, Unified_Backend, and Frontend_App
2. WHEN docker-compose up is executed, THE services SHALL start in dependency order (ShrikDB first, then Backend, then Frontend)
3. THE docker-compose.yml SHALL include health checks for each service
4. THE docker-compose.yml SHALL define a shared network for inter-service communication
5. THE docker-compose.yml SHALL use environment variables for all secrets and configuration
6. WHEN a service fails health checks, THE docker-compose SHALL report the failure clearly

### Requirement 5: WebSocket Authentication

**User Story:** As a security engineer, I want WebSocket connections to require authentication, so that unauthorized clients cannot access real-time data.

#### Acceptance Criteria

1. WHEN a WebSocket connection is attempted without credentials, THE WebSocket_Server SHALL reject with code 4001
2. WHEN valid credentials are provided, THE WebSocket_Server SHALL accept the connection and send a welcome message
3. WHEN invalid credentials are provided, THE WebSocket_Server SHALL reject with code 4003
4. THE WebSocket_Server SHALL reuse the existing client_id/client_key authentication mechanism
5. WHEN a connection is rejected, THE WebSocket_Server SHALL log the rejection reason

### Requirement 6: WebSocket Reconnection

**User Story:** As a frontend developer, I want WebSocket connections to reconnect automatically with backoff, so that temporary disconnections don't break the UI.

#### Acceptance Criteria

1. WHEN a WebSocket connection is lost, THE Frontend_App SHALL attempt to reconnect automatically
2. THE reconnection attempts SHALL use exponential backoff (delay doubles each attempt)
3. THE reconnection attempts SHALL NOT create infinite loops (maximum 10 attempts)
4. WHEN reconnection succeeds, THE Frontend_App SHALL resume receiving real-time data
5. WHEN all reconnection attempts fail, THE Frontend_App SHALL display a manual reconnect option
6. THE Frontend_App SHALL display the current connection status (connected, reconnecting, disconnected)

### Requirement 7: Real-Time Data Streaming

**User Story:** As a user, I want to see real-time logs, metrics, and stream events, so that I can monitor the system effectively.

#### Acceptance Criteria

1. WHEN the backend processes events, THE WebSocket_Server SHALL broadcast log entries to connected clients
2. WHEN metrics change, THE WebSocket_Server SHALL broadcast metric updates to connected clients
3. WHEN stream events occur, THE WebSocket_Server SHALL broadcast them to subscribed clients
4. THE WebSocket_Server SHALL only stream data from the ShrikDB event log (no mock data)
5. WHEN the ShrikDB_Engine is unavailable, THE WebSocket_Server SHALL notify clients of the disconnection

### Requirement 8: Backend-to-Engine Communication

**User Story:** As a system architect, I want the backend to communicate with ShrikDB via the event API only, so that the WAL remains the single source of truth.

#### Acceptance Criteria

1. THE Unified_Backend SHALL subscribe to ShrikDB engine events via the event API
2. THE Unified_Backend SHALL NOT bypass the WAL or event APIs for any data operation
3. WHEN streaming data to clients, THE Unified_Backend SHALL source it from ShrikDB events only
4. THE Unified_Backend SHALL NOT buffer fake state or generate synthetic data
5. WHEN the ShrikDB_Engine emits events, THE Unified_Backend SHALL forward them to WebSocket clients

### Requirement 9: Production Verification

**User Story:** As a QA engineer, I want to verify the production system works correctly, so that I can certify it for deployment.

#### Acceptance Criteria

1. WHEN WebSocket connects, THE system SHALL be verified as passing the connectivity test
2. WHEN logs stream live during backend operation, THE system SHALL be verified as passing the log streaming test
3. WHEN metrics change after event appends, THE system SHALL be verified as passing the metrics test
4. WHEN the backend is killed, THE Frontend_App SHALL show disconnect status within 5 seconds
5. WHEN services restart, THE system SHALL restore state automatically without manual intervention
6. THE system SHALL NOT produce 401/500 error loops during normal operation
7. THE system SHALL NOT produce console errors during normal operation
8. THE system SHALL NOT display any mock or demo output

### Requirement 10: Service Resilience

**User Story:** As a system operator, I want services to handle failures gracefully, so that the system remains stable.

#### Acceptance Criteria

1. WHEN the ShrikDB_Engine restarts, THE Unified_Backend SHALL reconnect automatically
2. WHEN the Unified_Backend restarts, THE Frontend_App SHALL reconnect WebSocket automatically
3. WHEN any service restarts, THE system SHALL restore previous state from the WAL
4. THE services SHALL start cleanly without requiring manual intervention
5. THE services SHALL expose correct ports as defined in the architecture
6. WHEN a service fails to start, THE system SHALL provide clear error messages
