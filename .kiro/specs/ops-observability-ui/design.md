# Design Document: Ops Observability UI

## Overview

This design describes a minimal internal Ops/Observability panel integrated into the existing ShrikDB frontend. The panel provides real-time visibility into system state including logs, metrics, errors, benchmarks, and health status. The design strictly adheres to the constraint of displaying only real data from existing backend APIs and WebSocket streams — no mocks, no simulations, no fake data.

The implementation adds a new `Ops.tsx` page component to the existing frontend, reusing the established patterns from `Monitoring.tsx` while focusing specifically on operational observability with a read-only interface.

## Architecture

```mermaid
graph TB
    subgraph Frontend
        OpsUI[Ops.tsx Page]
        LogPanel[Log Stream Panel]
        MetricsPanel[Metrics Panel]
        HealthPanel[Health Panel]
        ErrorPanel[Error Panel]
        BenchmarkPanel[Benchmark Panel]
        FilterBar[Filter Bar]
    end
    
    subgraph Backend APIs
        RecoveryAPI[/api/recovery/status]
        MetricsAPI[/api/metrics]
        WorkersAPI[/api/workers]
        PartitionsAPI[/api/partitions]
        ViolationsAPI[/api/security/violations]
        BackpressureAPI[/api/backpressure/status]
    end
    
    subgraph WebSocket
        WSServer[WebSocket Server :3002]
        LogStream[/ws/logs]
    end
    
    OpsUI --> LogPanel
    OpsUI --> MetricsPanel
    OpsUI --> HealthPanel
    OpsUI --> ErrorPanel
    OpsUI --> BenchmarkPanel
    OpsUI --> FilterBar
    
    LogPanel --> LogStream
    MetricsPanel --> MetricsAPI
    MetricsPanel --> WorkersAPI
    HealthPanel --> RecoveryAPI
    ErrorPanel --> ViolationsAPI
    ErrorPanel --> LogStream
    
    LogStream --> WSServer
```

## Components and Interfaces

### 1. Ops Page Component (`pages/Ops.tsx`)

The main page component that orchestrates all observability panels.

```typescript
interface OpsPageProps {
  // No props - uses internal state and API calls
}

interface OpsPageState {
  logs: LogEntry[];
  metrics: SystemMetrics;
  health: HealthStatus;
  errors: ErrorEntry[];
  benchmarks: BenchmarkResult[];
  filters: FilterState;
  wsConnectionState: WebSocketConnectionState;
}
```

### 2. Log Stream Panel

Displays real-time logs from WebSocket connection.

```typescript
interface LogEntry {
  timestamp: string;
  service: 'api' | 'wal' | 'replay' | 'worker' | 'system';
  level: 'error' | 'warn' | 'info' | 'debug';
  message: string;
  correlation_id?: string;
  component?: string;
  data?: Record<string, any>;
}

interface LogStreamPanelProps {
  logs: LogEntry[];
  filters: FilterState;
  maxEntries: number; // Default 1000
  autoScroll: boolean;
}
```

### 3. Metrics Panel

Displays real-time metrics from `/api/metrics` endpoint.

```typescript
interface SystemMetrics {
  eventsPerSecond: number;
  appendLatencyP50: number;
  appendLatencyP95: number;
  readLatencyP50: number;
  readLatencyP95: number;
  errorCount: number;
  storageUsedBytes: number;
  appendRequests: number;
  readRequests: number;
  activeWorkers: number;
  totalPartitions: number;
  lastUpdated: string;
}

interface MetricsPanelProps {
  metrics: SystemMetrics;
  isLoading: boolean;
  error?: string;
  refreshInterval: number; // Default 5000ms
}
```

### 4. Health Panel

Displays service health from `/api/recovery/status` endpoint.

```typescript
interface HealthStatus {
  services: {
    shrikdb: { status: string; connected: boolean; url: string };
    unified_backend: { status: string; uptime_ms: number };
    websocket: { status: string; port: number };
  };
  reconnect_info: {
    shrikdb_reconnect_supported: boolean;
    websocket_reconnect_supported: boolean;
    exponential_backoff: boolean;
  };
  last_replay?: {
    timestamp: string;
    success: boolean;
    events_processed: number;
    duration_ms: number;
  };
}

interface HealthPanelProps {
  health: HealthStatus | null;
  isLoading: boolean;
  error?: string;
}
```

### 5. Error Panel

Displays errors, warnings, and security violations.

```typescript
interface ErrorEntry {
  timestamp: string;
  type: 'error' | 'warning' | 'security_violation';
  source: string;
  message: string;
  details?: Record<string, any>;
}

interface SecurityViolation {
  type: string;
  tenantId: string;
  namespaceId: string;
  reason: string;
  timestamp: string;
  correlationId: string;
}

interface ErrorPanelProps {
  errors: ErrorEntry[];
  violations: SecurityViolation[];
  filter: 'all' | 'errors' | 'warnings' | 'violations';
}
```

### 6. Benchmark Panel

Displays benchmark results from stored JSON files.

```typescript
interface BenchmarkResult {
  timestamp: string;
  name: string;
  appendLatencyMs: number;
  readLatencyMs: number;
  throughputOpsPerSec: number;
  eventsProcessed: number;
  duration_ms: number;
  source: string; // File path or API endpoint
}

interface BenchmarkPanelProps {
  benchmarks: BenchmarkResult[];
  isLoading: boolean;
  error?: string;
}
```

### 7. Filter Bar

Provides filtering controls for project, tenant, service, and log level.

```typescript
interface FilterState {
  project: string | null;
  tenant: string | null;
  service: string | null;
  logLevel: string | null;
}

interface FilterBarProps {
  filters: FilterState;
  onFilterChange: (filters: FilterState) => void;
  projects: string[];
  tenants: string[];
  services: string[];
  logLevels: string[];
}
```

## Data Models

### API Response Types

```typescript
// GET /api/metrics response
interface MetricsResponse {
  success: boolean;
  metrics: {
    totalDocuments: number;
    activeStreams: number;
    eventsPerSecond: number;
    storageUsedBytes: number;
    appendRequests: number;
    readRequests: number;
    replayRequests: number;
    syncsPerformed: number;
    appendLatencyP50: number;
    appendLatencyP99: number;
    readLatencyP50: number;
    readLatencyP99: number;
    errorCount: number;
  };
  timestamp: string;
  correlation_id: string;
}

// GET /api/recovery/status response
interface RecoveryStatusResponse {
  success: boolean;
  recovery: HealthStatus;
  timestamp: string;
  correlation_id: string;
}

// GET /api/security/violations response
interface ViolationsResponse {
  success: boolean;
  violations: SecurityViolation[];
  count: number;
  timestamp: string;
  correlation_id: string;
}

// GET /api/workers response
interface WorkersResponse {
  success: boolean;
  workers: WorkerInfo[];
  active_workers: number;
  total_workers: number;
  timestamp: string;
  correlation_id: string;
}

// WebSocket log message
interface WebSocketLogMessage {
  type: 'log' | 'welcome' | 'pong' | 'worker_update' | 'partition_update';
  timestamp: string;
  level?: string;
  service?: string;
  component?: string;
  message?: string;
  data?: Record<string, any>;
  correlation_id?: string;
}
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Log Filtering Correctness

*For any* set of log entries and any combination of service and level filters, the filtered result SHALL contain only entries that match ALL applied filters (AND logic).

**Validates: Requirements 1.4, 1.5, 4.6**

### Property 2: Log Entry Completeness

*For any* log entry received via WebSocket, the rendered display SHALL contain the timestamp, service, level, message, and correlation_id fields.

**Validates: Requirements 1.6**

### Property 3: Log Buffer Size Constraint

*For any* sequence of log entries added to the buffer, the buffer size SHALL never exceed 1000 entries, with oldest entries removed first (FIFO).

**Validates: Requirements 1.8**

### Property 4: WebSocket Reconnection Backoff

*For any* sequence of WebSocket disconnections, the reconnection delay SHALL follow exponential backoff pattern: delay(n) = min(baseDelay * 2^n, maxDelay).

**Validates: Requirements 1.7**

### Property 5: Metrics Data Binding

*For any* successful response from /api/metrics, the UI SHALL display the exact values returned by the API without transformation or generation.

**Validates: Requirements 3.1, 3.7**

### Property 6: Health Status Data Binding

*For any* successful response from /api/recovery/status, the UI SHALL display the exact service states returned by the API.

**Validates: Requirements 2.2, 2.6**

### Property 7: Error State Handling

*For any* failed API fetch, the UI SHALL display zeros or "Data unavailable" message, never mock or generated data.

**Validates: Requirements 3.7, 10.3**

### Property 8: Project/Tenant Filter Correctness

*For any* set of logs/metrics and any project or tenant filter selection, the displayed data SHALL contain only entries matching the selected filter.

**Validates: Requirements 6.3, 6.4**

### Property 9: Read-Only Constraint

*For any* rendered UI state, there SHALL be no buttons, forms, or controls that trigger POST, PUT, PATCH, or DELETE API calls.

**Validates: Requirements 9.1, 9.2, 9.3, 9.4**

### Property 10: Benchmark Data Consistency

*For any* benchmark result displayed in the UI, the values SHALL exactly match the corresponding stored benchmark JSON file.

**Validates: Requirements 5.2, 11.4**

### Property 11: Error Visual Distinction

*For any* log entry with level 'error', the rendered element SHALL have distinct visual styling (CSS class or inline style) compared to non-error entries.

**Validates: Requirements 4.2**

## Error Handling

### WebSocket Connection Errors

1. On connection failure: Display "Connecting..." status, attempt reconnection with exponential backoff
2. On max reconnection attempts reached: Display "Connection failed" with manual reconnect button
3. On message parse error: Log to console, skip invalid message, continue processing

### API Fetch Errors

1. On network error: Display "Service unavailable" with last known timestamp
2. On 4xx error: Display specific error message from response
3. On 5xx error: Display "Server error" with retry option
4. On timeout: Display "Request timed out" with retry option

### Data Validation Errors

1. On missing required fields: Display partial data with "Incomplete data" indicator
2. On invalid data types: Use default values (0 for numbers, "" for strings)
3. On null/undefined: Display "N/A" or appropriate placeholder

## Testing Strategy

### Unit Tests

Unit tests verify specific examples and edge cases:

1. Filter component renders correct options
2. Log entry renders all required fields
3. Metrics panel displays zeros on error
4. Health panel shows correct status colors
5. Benchmark panel shows "No data" when empty

### Property-Based Tests

Property-based tests verify universal properties across all inputs using fast-check:

1. **Log filtering property**: Generate random logs and filters, verify filter correctness
2. **Buffer size property**: Generate random log sequences, verify buffer never exceeds limit
3. **Reconnection backoff property**: Generate disconnect sequences, verify delay pattern
4. **Data binding property**: Generate random API responses, verify exact display
5. **Read-only property**: Scan rendered UI for mutation controls, verify none exist

### Integration Tests

Integration tests verify end-to-end behavior:

1. Service restart reflects in logs
2. Event append increases metrics
3. Replay shows in log stream
4. Benchmark display matches files

### Test Configuration

- Property tests: Minimum 100 iterations per property
- Test framework: Vitest with fast-check for property-based testing
- Tag format: **Feature: ops-observability-ui, Property {number}: {property_text}**
