# ShrikDB Phase 3B Monitoring System

This document describes the comprehensive monitoring and testing system for ShrikDB Phase 3B Scale & Isolation Hardening.

## Features

### 🖥️ Web-Based Monitoring Interface
- **Real-time log streaming** via WebSocket connections
- **Service status monitoring** with health checks
- **Interactive testing interface** for Phase 3B features
- **Log filtering and search** by service and log level
- **Service management** (start/stop all services)

### 🔧 Service Management
- **Unified startup script** that manages all ShrikDB services
- **Automatic service discovery** and health monitoring
- **Process lifecycle management** with restart capabilities
- **Centralized logging** with structured log format

### 🧪 Testing Integration
- **Phase 3B verification tests** with real-time progress
- **Noisy neighbor isolation tests** with configurable parameters
- **Crash and replay verification** for deterministic behavior
- **Machine-verifiable assertions** with JSON output

### 📊 Phase 3B Metrics
- **Namespace-level metrics** (throttle, rejection, queue depth, latency)
- **System-wide statistics** for all Phase 3B components
- **Quota management interface** for setting namespace limits
- **Real-time performance monitoring**

## Quick Start

### 1. Start All Services with Monitoring
```bash
npm run start-all
```

This starts:
- ShrikDB Backend (port 8080)
- Unified Backend API with Monitoring (port 3001)
- Frontend Development Server (port 3000)
- WebSocket Log Streaming (port 3002)

### 2. Access the Monitoring Interface
1. Open your browser to `http://localhost:3000`
2. Navigate to the **"Monitoring"** tab in the sidebar
3. Use the interface to:
   - Start/stop services
   - View real-time logs
   - Run Phase 3B tests
   - Monitor system metrics

### 3. Run Phase 3B Verification Tests
```bash
npm run verify-phase3b
```

Or use the web interface "Run Full Phase 3B Tests" button.

## API Endpoints

### Service Management
- `POST /api/services/start-all` - Start all ShrikDB services
- `POST /api/services/stop-all` - Stop all services
- `GET /api/services/status` - Get service status

### Testing
- `POST /api/tests/phase3b` - Run Phase 3B verification tests (streaming)
- `POST /api/tests/noisy-neighbor` - Run noisy neighbor isolation test
- `GET /api/tests/results/:testId` - Get test results

### Logs
- `GET /api/logs/services` - Get service logs with filtering
- `GET /api/logs/clear` - Clear all logs
- `ws://localhost:3002/ws/logs` - Real-time log streaming

### Phase 3B Metrics
- `GET /api/phase3b/metrics/:tenantId/:namespaceId` - Get namespace metrics
- `GET /api/phase3b/system-stats` - Get system-wide statistics
- `POST /api/phase3b/quota/:tenantId/:namespaceId` - Set namespace quota

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Frontend      │    │  Unified Backend │    │  ShrikDB Core   │
│   (React)       │◄──►│  API + Monitor   │◄──►│  (Go)           │
│   Port 3000     │    │  Port 3001       │    │  Port 8080      │
└─────────────────┘    └──────────────────┘    └─────────────────┘
         │                       │
         │              ┌────────▼────────┐
         │              │  WebSocket      │
         └──────────────►│  Log Stream     │
                        │  Port 3002      │
                        └─────────────────┘
```

## Log Format

All logs use structured JSON format:
```json
{
  "timestamp": "2025-01-04T10:30:00.000Z",
  "service": "shrikdb",
  "level": "info",
  "message": "Event appended successfully",
  "data": {
    "sequence_number": 12345,
    "tenant_id": "tenant-1",
    "namespace_id": "namespace-1"
  }
}
```

## Phase 3B Testing

The monitoring system includes comprehensive Phase 3B testing:

### 1. Multi-Namespace Setup
- Creates multiple tenants and namespaces
- Configures quotas and rate limits
- Verifies isolation boundaries

### 2. Noisy Neighbor Test
- Floods one namespace with excessive load
- Monitors impact on other namespaces
- Verifies throttling and isolation

### 3. Crash and Replay Verification
- Takes system state snapshots
- Simulates crashes and restarts
- Verifies deterministic replay behavior

### 4. Metrics Validation
- Tests all Phase 3B metrics collection
- Verifies replay-safe calculations
- Validates event-derived timing

## Configuration

Environment variables:
- `PORT` - Unified API port (default: 3001)
- `SHRIKDB_URL` - ShrikDB backend URL (default: http://localhost:8080)
- `CORS_ORIGIN` - Frontend origin (default: http://localhost:3000)

## Troubleshooting

### WebSocket Connection Issues
- Ensure port 3002 is available
- Check firewall settings
- Verify the monitoring extension is loaded

### Service Startup Issues
- Check that all dependencies are installed (`npm install`)
- Verify ShrikDB binary exists at `./shrikdb/shrikdb.exe`
- Check port availability (8080, 3000, 3001, 3002)

### Test Failures
- Ensure ShrikDB backend is running and healthy
- Check that Phase 3B components are properly integrated
- Review test logs for specific error details

## Development

To extend the monitoring system:

1. **Add new endpoints** in `monitoring-api-extension.js`
2. **Update the frontend** in `pages/Monitoring.tsx`
3. **Add new tests** in `verify-phase3b.js`
4. **Extend log streaming** by modifying the WebSocket handlers

The system is designed to be modular and extensible for future ShrikDB phases.