# Design Document: Production Docker Deployment

## Overview

This design document describes the architecture and implementation approach for containerizing the ShrikDB full-stack system using Docker. The system consists of three containerized services: ShrikDB Engine (Go), Unified Backend (Node.js), and Frontend (React/nginx). All services communicate via a shared Docker network with authenticated WebSocket connections for real-time data streaming.

## Architecture

```mermaid
graph TB
    subgraph Docker["Docker Compose Environment"]
        subgraph Frontend["Frontend Container (nginx:3000)"]
            Nginx[nginx reverse proxy]
            StaticFiles[React Static Build]
        end

        subgraph Backend["Backend Container (node:3001/3002)"]
            API[Express API Server :3001]
            WS[WebSocket Server :3002]
            AuthService[Auth Service]
            EventSubscriber[ShrikDB Event Subscriber]
        end

        subgraph Engine["ShrikDB Container (go:8080)"]
            HTTPServer[HTTP Server :8080]
            EventAPI[Event API]
            WAL[Write-Ahead Log]
            HealthEndpoint[/health endpoint]
        end

        subgraph Volumes["Persistent Volumes"]
            WALVolume[(WAL Data Volume)]
        end
    end

    Client[Browser Client] --> Nginx
    Nginx -->|/api/*| API
    Nginx -->|/ws/*| WS
    
    API --> AuthService
    API --> HTTPServer
    WS --> AuthService
    WS --> EventSubscriber
    EventSubscriber --> EventAPI
    
    HTTPServer --> EventAPI
    EventAPI --> WAL
    WAL --> WALVolume
```

## Components and Interfaces

### 1. ShrikDB Engine Container

#### Dockerfile Structure
```dockerfile
# Multi-stage build for minimal image size
FROM golang:1.21-alpine AS builder
WORKDIR /app
COPY shrikdb/ .
RUN go build -o shrikdb ./cmd/shrikdb

FROM alpine:3.19
WORKDIR /app
COPY --from=builder /app/shrikdb .
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s \
  CMD wget -q --spider http://localhost:8080/health || exit 1
ENTRYPOINT ["./shrikdb"]
```

#### Health Check Endpoint
```go
// GET /health
type HealthResponse struct {
    Status    string `json:"status"`    // "healthy" or "unhealthy"
    WALStatus string `json:"wal_status"` // "ready" or "recovering"
    Uptime    int64  `json:"uptime_seconds"`
}
```

### 2. Unified Backend Container

#### Dockerfile Structure
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY *.js ./
COPY streams/ ./streams/
EXPOSE 3001 3002
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s \
  CMD wget -q --spider http://localhost:3001/api/health || exit 1
CMD ["node", "server.js"]
```

#### Environment Variables
```
SHRIKDB_HOST=shrikdb
SHRIKDB_PORT=8080
WS_PORT=3002
API_PORT=3001
LOG_LEVEL=info
```

#### WebSocket Authentication Interface
```javascript
// WebSocket connection with authentication
// ws://backend:3002/ws/logs?client_id=xxx&client_key=yyy

class AuthenticatedWebSocketServer {
  // Validate credentials on connection
  async handleConnection(ws, request) {
    const { client_id, client_key } = parseQueryParams(request.url);
    
    if (!client_id || !client_key) {
      ws.close(4001, 'Missing credentials');
      return;
    }
    
    const isValid = await this.authService.validateCredentials(client_id, client_key);
    if (!isValid) {
      ws.close(4003, 'Invalid credentials');
      return;
    }
    
    // Accept connection
    ws.send(JSON.stringify({ type: 'welcome', timestamp: new Date().toISOString() }));
    this.subscribeToEvents(ws, client_id);
  }
}
```

### 3. Frontend Container

#### Dockerfile Structure
```dockerfile
# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s \
  CMD wget -q --spider http://localhost:3000 || exit 1
CMD ["nginx", "-g", "daemon off;"]
```

#### nginx Configuration
```nginx
server {
    listen 3000;
    server_name localhost;
    
    root /usr/share/nginx/html;
    index index.html;
    
    # API proxy
    location /api/ {
        proxy_pass http://backend:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
    
    # WebSocket proxy
    location /ws/ {
        proxy_pass http://backend:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
    
    # SPA fallback
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

### 4. Docker Compose Configuration

```yaml
version: '3.8'

services:
  shrikdb:
    build:
      context: ./shrikdb
      dockerfile: Dockerfile
    ports:
      - "8080:8080"
    volumes:
      - shrikdb-data:/app/data
    environment:
      - DATA_DIR=/app/data
      - LOG_LEVEL=${LOG_LEVEL:-info}
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:8080/health"]
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 5s
    networks:
      - shrikdb-network

  backend:
    build:
      context: .
      dockerfile: Dockerfile.backend
    ports:
      - "3001:3001"
      - "3002:3002"
    environment:
      - SHRIKDB_HOST=shrikdb
      - SHRIKDB_PORT=8080
      - API_PORT=3001
      - WS_PORT=3002
      - LOG_LEVEL=${LOG_LEVEL:-info}
    depends_on:
      shrikdb:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:3001/api/health"]
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 10s
    networks:
      - shrikdb-network

  frontend:
    build:
      context: .
      dockerfile: Dockerfile.frontend
    ports:
      - "3000:3000"
    depends_on:
      backend:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:3000"]
      interval: 10s
      timeout: 3s
      retries: 3
    networks:
      - shrikdb-network

volumes:
  shrikdb-data:

networks:
  shrikdb-network:
    driver: bridge
```

## Data Models

### WebSocket Message Types
```typescript
// Outbound messages from server to client
interface WebSocketMessage {
  type: 'welcome' | 'log' | 'metric' | 'stream_event' | 'disconnect' | 'error';
  timestamp: string;
  data?: unknown;
}

interface LogMessage extends WebSocketMessage {
  type: 'log';
  data: {
    level: 'error' | 'warn' | 'info' | 'debug';
    service: string;
    message: string;
    correlation_id?: string;
  };
}

interface MetricMessage extends WebSocketMessage {
  type: 'metric';
  data: {
    name: string;
    value: number;
    labels?: Record<string, string>;
  };
}

interface StreamEventMessage extends WebSocketMessage {
  type: 'stream_event';
  data: {
    stream: string;
    event_id: string;
    payload: unknown;
  };
}
```

### Connection State
```typescript
interface ConnectionState {
  status: 'connected' | 'reconnecting' | 'disconnected';
  lastConnected: Date | null;
  reconnectAttempts: number;
  maxReconnectAttempts: number; // 10
  backoffMs: number; // Current backoff delay
}
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Service Port Availability

*For any* Docker container start of ShrikDB, Backend, or Frontend, the service SHALL listen on its designated port (8080, 3001/3002, or 3000 respectively) within 30 seconds of container start.

**Validates: Requirements 1.2, 2.2, 3.2**

### Property 2: WAL State Recovery

*For any* set of events E written to the WAL before a service restart, after the restart completes, querying the system SHALL return all events in E with no data loss.

**Validates: Requirements 1.4, 1.6, 10.3**

### Property 3: WebSocket Authentication

*For any* WebSocket connection attempt, IF credentials are missing THEN the server SHALL reject with code 4001, IF credentials are invalid THEN the server SHALL reject with code 4003, IF credentials are valid THEN the server SHALL accept and send a welcome message.

**Validates: Requirements 5.1, 5.2, 5.3, 5.5**

### Property 4: WebSocket Reconnection Backoff

*For any* sequence of reconnection attempts after a WebSocket disconnection, the delay between attempt N and attempt N+1 SHALL be at least 2x the delay between attempt N-1 and attempt N (exponential backoff), and the total number of automatic attempts SHALL NOT exceed 10.

**Validates: Requirements 6.2, 6.3**

### Property 5: WebSocket Reconnection Data Resume

*For any* successful WebSocket reconnection after a disconnection, the client SHALL resume receiving real-time data (logs, metrics, stream events) within 5 seconds of reconnection.

**Validates: Requirements 6.1, 6.4**

### Property 6: Real-Time Data Broadcasting

*For any* event processed by the backend (log entry, metric update, or stream event), the WebSocket server SHALL broadcast it to all authenticated connected clients within 1 second of processing.

**Validates: Requirements 7.1, 7.2, 7.3**

### Property 7: Data Source Integrity

*For any* data item D streamed via WebSocket to a client, there SHALL exist a corresponding event in the ShrikDB event log that is the source of D (no mock or synthetic data).

**Validates: Requirements 7.4, 8.3**

### Property 8: Backend-to-Engine Event Forwarding

*For any* event E emitted by the ShrikDB Engine, the Unified Backend SHALL forward E to all subscribed WebSocket clients, preserving the event content and order.

**Validates: Requirements 8.5**

### Property 9: Disconnect Detection Timing

*For any* backend service termination, the Frontend SHALL display a disconnected status within 5 seconds of the termination.

**Validates: Requirements 9.4**

### Property 10: Production Quality Output

*For any* normal operation period of the system, there SHALL be zero HTTP 401/500 error loops, zero console errors, and zero mock/demo data displayed.

**Validates: Requirements 9.6, 9.7, 9.8**

### Property 11: Service Auto-Reconnection

*For any* restart of ShrikDB Engine or Unified Backend, the dependent services SHALL automatically reconnect within 30 seconds without manual intervention.

**Validates: Requirements 10.1, 10.2**

### Property 12: Connection Status Display

*For any* WebSocket connection state change (connected → disconnected, disconnected → reconnecting, reconnecting → connected), the Frontend SHALL display the accurate current status within 1 second of the state change.

**Validates: Requirements 6.6**

## Error Handling

### Container Startup Errors

| Error | Cause | Handling |
|-------|-------|----------|
| Port already in use | Another process on host | Log error, exit with code 1 |
| WAL directory not writable | Permission issue | Log error, exit with code 1 |
| ShrikDB unreachable | Network or service issue | Retry with exponential backoff |
| Invalid environment variable | Configuration error | Log error, exit with code 1 |

### WebSocket Errors

| Error Code | Meaning | Client Action |
|------------|---------|---------------|
| 4001 | Missing credentials | Prompt for login |
| 4003 | Invalid credentials | Prompt for re-login |
| 1006 | Abnormal closure | Reconnect with backoff |
| 1011 | Server error | Reconnect with backoff |

### Health Check Failures

- ShrikDB health check fails: Backend retries connection
- Backend health check fails: Frontend shows "Backend unavailable"
- Frontend health check fails: nginx returns 503

## Testing Strategy

### Unit Tests

Unit tests verify specific examples and edge cases:

1. **Dockerfile Build Tests**: Verify each Dockerfile builds successfully
2. **nginx Configuration Tests**: Verify proxy rules work correctly
3. **WebSocket Auth Tests**: Verify credential validation logic
4. **Reconnection Logic Tests**: Verify backoff calculation

### Property-Based Tests

Property-based tests verify universal properties using fast-check:

1. **Port Availability**: Generate random startup sequences, verify ports
2. **WAL Recovery**: Generate random event sets, restart, verify recovery
3. **WebSocket Auth**: Generate random credential combinations, verify responses
4. **Reconnection Backoff**: Generate random disconnection sequences, verify timing
5. **Data Integrity**: Generate random events, verify WebSocket output matches source

### Integration Tests

Integration tests verify end-to-end flows:

1. **Full Stack Startup**: `docker-compose up` and verify all services healthy
2. **WebSocket Flow**: Connect, authenticate, receive events
3. **Recovery Flow**: Kill service, verify reconnection and state recovery
4. **Error Flow**: Invalid credentials, verify proper rejection

### Verification Script

A verification script will test all non-negotiable criteria:

```javascript
// verify-production.js
async function verifyProduction() {
  const results = {
    websocketConnects: false,
    logsStreamLive: false,
    metricsChange: false,
    disconnectShows: false,
    restartRestores: false,
    noErrorLoops: false,
    noConsoleErrors: false,
    noMockOutput: false
  };
  
  // Test each criterion...
  
  const allPassed = Object.values(results).every(v => v);
  console.log(allPassed ? 'PRODUCTION READY' : 'VERIFICATION FAILED');
  return results;
}
```

### Test Configuration

- Property tests: Minimum 100 iterations per property
- Integration tests: Run against real Docker containers (no mocks)
- Verification tests: Run full verification script before deployment
- All tests tagged with feature and property references
