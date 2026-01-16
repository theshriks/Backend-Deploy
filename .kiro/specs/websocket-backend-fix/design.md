# Design Document: WebSocket Backend Fix

## Overview

This design addresses the WebSocket log stream backend connectivity issue. The Ops UI correctly shows a real backend failure - the WebSocket server on port 3002 is not running. The fix ensures the WebSocket server starts automatically with the unified backend and is properly health-checked during service orchestration.

## Architecture

The WebSocket server is already implemented in `websocket-server.js` and integrated via `monitoring-api-extension.js`. The issue is that the server needs to be started when the backend services start.

```
┌─────────────────────────────────────────────────────────────────┐
│                     Service Startup Flow                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. ShrikDB Core (port 8080)                                    │
│         ↓                                                        │
│  2. Unified Backend (port 3001)                                 │
│         ↓                                                        │
│  3. WebSocket Server (port 3002) ← Started by server.js         │
│         ↓                                                        │
│  4. Frontend (port 3000)                                        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Components and Interfaces

### Existing Components (No Changes Needed)

1. **websocket-server.js** - WebSocket server implementation (already complete)
2. **monitoring-api-extension.js** - Integrates WebSocket with unified backend (already complete)
3. **server.js** - Starts unified backend with WebSocket server (already complete)
4. **pages/Ops.tsx** - Frontend UI with reconnection logic (already complete)

### Component: Service Orchestrator Enhancement

The `service-orchestrator.js` already has WebSocket health check logic. The issue is that when running `node server.js` directly (not through orchestrator), the WebSocket server starts correctly.

**Current Flow:**
- `server.js` → starts `UnifiedBackendAPI` + `MonitoringAPIExtension` → starts `WebSocketServer`

**The Fix:**
The backend services need to be started using `node server.js` which properly initializes the WebSocket server.

## Data Models

No new data models required. The existing WebSocket message format is:

```typescript
interface WebSocketMessage {
  type: 'log' | 'welcome' | 'pong' | 'worker_update' | 'partition_update';
  timestamp: string;
  level?: 'error' | 'warn' | 'info' | 'debug';
  service?: string;
  component?: string;
  message?: string;
  data?: Record<string, unknown>;
  correlation_id?: string;
}
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Health Endpoint WebSocket Status Inclusion

*For any* call to the `/api/recovery/status` endpoint, the response SHALL include a `services.websocket` object with `status` and `port` fields.

**Validates: Requirements 3.1**

### Property 2: WebSocket Server Port Consistency

*For any* successful WebSocket server startup, the server SHALL listen on port 3002 at path `/ws/logs`.

**Validates: Requirements 1.1**

## Error Handling

### Port Conflict (EADDRINUSE)

When port 3002 is already in use:
1. Log error: "Port 3002 is already in use. Please check if another service is running on this port."
2. The WebSocket server will not start
3. Health endpoint will report `status: "unavailable"`

### Connection Failures

When WebSocket connections fail:
1. Client receives `onclose` or `onerror` event
2. Ops UI shows "WebSocket disconnected" with reconnection attempt count
3. Exponential backoff with jitter prevents thundering herd
4. After 10 attempts, shows "Connection Failed" with manual reconnect button

## Testing Strategy

### Unit Tests

1. **WebSocket Server Startup Test** - Verify server starts on correct port
2. **Health Endpoint Test** - Verify response includes WebSocket status
3. **Port Conflict Test** - Verify clear error message when port is in use

### Property-Based Tests

1. **Health Endpoint Response Property** - For all calls, response includes websocket status

### Integration Tests

1. **End-to-End Startup Test** - Start server.js and verify WebSocket is reachable
2. **Reconnection Test** - Verify client reconnects after server restart

### Manual Verification

To verify the fix works:
1. Run `node server.js` to start the backend
2. Open the Ops UI at http://localhost:3000/ops
3. Verify "WebSocket connected" status appears
4. Verify logs start flowing in real-time
