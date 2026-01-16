# Design Document: File Content Persistence

## Overview

This design introduces a content-addressable storage layer for ShrikDB that persists actual file bytes to a backing store while maintaining the WAL as the single source of truth for metadata. The architecture prioritizes single-node performance with streaming uploads, strict durability ordering, and zero API breakage.

## Architecture

```mermaid
graph TB
    subgraph "Client Layer"
        C[Client]
    end
    
    subgraph "API Layer"
        API[HTTP API]
        BP[Backpressure Controller]
    end
    
    subgraph "Storage Layer"
        CS[Content Store]
        WAL[Write-Ahead Log]
    end
    
    subgraph "Backing Store"
        FS[Filesystem]
        OBJ[Object Store - Future]
    end
    
    C -->|Stream Upload| API
    API -->|Flow Control| BP
    BP -->|Stream Bytes| CS
    CS -->|Persist| FS
    CS -->|Hash + Pointer| WAL
    
    WAL -.->|Never Contains| BYTES[Raw Bytes]


## Components and Interfaces

### Content Store Interface

```go
// ContentStore manages content-addressable byte storage
type ContentStore interface {
    // Store persists bytes and returns metadata (hash, size, pointer)
    // Streams bytes directly to backing store without full buffering
    Store(ctx context.Context, reader io.Reader, mimeType string) (*ContentMetadata, error)
    
    // Retrieve streams bytes from backing store
    Retrieve(ctx context.Context, pointer string) (io.ReadCloser, error)
    
    // RetrieveRange retrieves a byte range (for partial content)
    RetrieveRange(ctx context.Context, pointer string, start, end int64) (io.ReadCloser, error)
    
    // Exists checks if content exists by hash
    Exists(ctx context.Context, hash string) (bool, error)
    
    // Delete removes content (for garbage collection)
    Delete(ctx context.Context, pointer string) error
    
    // Verify checks content integrity against stored hash
    Verify(ctx context.Context, pointer string, expectedHash string) (bool, error)
}

// ContentMetadata is stored in WAL, never raw bytes
type ContentMetadata struct {
    ContentHash    string `json:"content_hash"`    // SHA-256 of content
    Size           int64  `json:"size"`            // Byte count
    MIMEType       string `json:"mime_type"`       // Content type
    StoragePointer string `json:"storage_pointer"` // Path or object key
    StoredAt       time.Time `json:"stored_at"`
}
```

### Filesystem Content Store Implementation

```go
// FilesystemContentStore implements ContentStore using local filesystem
type FilesystemContentStore struct {
    baseDir       string
    tempDir       string
    chunkSize     int           // Streaming chunk size (default 64KB)
    maxConcurrent int           // Max concurrent writes
    semaphore     chan struct{} // Concurrency limiter
    metrics       *ContentStoreMetrics
    logger        zerolog.Logger
}

// Store streams bytes to filesystem with content-addressable naming
func (s *FilesystemContentStore) Store(ctx context.Context, reader io.Reader, mimeType string) (*ContentMetadata, error) {
    // 1. Acquire semaphore for backpressure
    select {
    case s.semaphore <- struct{}{}:
        defer func() { <-s.semaphore }()
    case <-ctx.Done():
        return nil, ctx.Err()
    }
    
    // 2. Create temp file for atomic write
    tempFile, err := os.CreateTemp(s.tempDir, "upload-*")
    if err != nil {
        return nil, fmt.Errorf("failed to create temp file: %w", err)
    }
    tempPath := tempFile.Name()
    defer os.Remove(tempPath) // Cleanup on failure
    
    // 3. Stream bytes while computing hash
    hasher := sha256.New()
    writer := io.MultiWriter(tempFile, hasher)
    
    var size int64
    buf := make([]byte, s.chunkSize)
    for {
        n, err := reader.Read(buf)
        if n > 0 {
            if _, writeErr := writer.Write(buf[:n]); writeErr != nil {
                tempFile.Close()
                return nil, fmt.Errorf("write failed: %w", writeErr)
            }
            size += int64(n)
        }
        if err == io.EOF {
            break
        }
        if err != nil {
            tempFile.Close()
            return nil, fmt.Errorf("read failed: %w", err)
        }
    }
    
    // 4. Sync to disk (durability guarantee)
    if err := tempFile.Sync(); err != nil {
        tempFile.Close()
        return nil, fmt.Errorf("sync failed: %w", err)
    }
    tempFile.Close()
    
    // 5. Compute final hash and storage path
    contentHash := hex.EncodeToString(hasher.Sum(nil))
    storagePath := s.hashToPath(contentHash)
    
    // 6. Check for existing content (deduplication)
    if _, err := os.Stat(storagePath); err == nil {
        // Content already exists, return existing metadata
        return &ContentMetadata{
            ContentHash:    contentHash,
            Size:           size,
            MIMEType:       mimeType,
            StoragePointer: storagePath,
            StoredAt:       time.Now(),
        }, nil
    }
    
    // 7. Ensure directory exists
    if err := os.MkdirAll(filepath.Dir(storagePath), 0755); err != nil {
        return nil, fmt.Errorf("failed to create directory: %w", err)
    }
    
    // 8. Atomic rename (durability guarantee)
    if err := os.Rename(tempPath, storagePath); err != nil {
        return nil, fmt.Errorf("rename failed: %w", err)
    }
    
    return &ContentMetadata{
        ContentHash:    contentHash,
        Size:           size,
        MIMEType:       mimeType,
        StoragePointer: storagePath,
        StoredAt:       time.Now(),
    }, nil
}

// hashToPath converts hash to sharded directory structure
// e.g., "abc123..." -> "content/ab/c1/abc123..."
func (s *FilesystemContentStore) hashToPath(hash string) string {
    return filepath.Join(s.baseDir, hash[:2], hash[2:4], hash)
}
```

### Backpressure Controller

```go
// BackpressureController manages flow control from storage to client
type BackpressureController struct {
    maxPendingBytes   int64
    currentPending    int64
    maxConcurrentOps  int
    currentOps        int
    mu                sync.Mutex
    cond              *sync.Cond
    metrics           *BackpressureMetrics
}

// Acquire blocks until resources are available
func (b *BackpressureController) Acquire(ctx context.Context, estimatedBytes int64) error {
    b.mu.Lock()
    defer b.mu.Unlock()
    
    for b.currentPending+estimatedBytes > b.maxPendingBytes || 
        b.currentOps >= b.maxConcurrentOps {
        
        // Check context before waiting
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
        }
        
        b.cond.Wait()
    }
    
    b.currentPending += estimatedBytes
    b.currentOps++
    return nil
}

// Release returns resources to the pool
func (b *BackpressureController) Release(actualBytes int64) {
    b.mu.Lock()
    b.currentPending -= actualBytes
    b.currentOps--
    b.cond.Broadcast()
    b.mu.Unlock()
}
```

### File Upload API Handler

```go
// FileUploadHandler handles streaming file uploads
type FileUploadHandler struct {
    contentStore   ContentStore
    wal            *wal.WAL
    backpressure   *BackpressureController
    maxFileSize    int64
    logger         zerolog.Logger
}

// HandleUpload processes a streaming file upload
func (h *FileUploadHandler) HandleUpload(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    
    // 1. Extract metadata from headers
    projectID := r.Header.Get("X-Project-ID")
    mimeType := r.Header.Get("Content-Type")
    contentLength := r.ContentLength
    
    // 2. Validate request
    if projectID == "" {
        http.Error(w, "X-Project-ID required", http.StatusBadRequest)
        return
    }
    
    // 3. Acquire backpressure slot
    if err := h.backpressure.Acquire(ctx, contentLength); err != nil {
        http.Error(w, "service overloaded", http.StatusServiceUnavailable)
        return
    }
    defer h.backpressure.Release(contentLength)
    
    // 4. Stream bytes to content store (FIRST - bytes must be durable)
    metadata, err := h.contentStore.Store(ctx, r.Body, mimeType)
    if err != nil {
        h.logger.Error().Err(err).Msg("content store failed")
        http.Error(w, "storage failed", http.StatusInternalServerError)
        return
    }
    
    // 5. Write WAL event (SECOND - only after bytes are durable)
    payload, _ := json.Marshal(map[string]interface{}{
        "content_hash":    metadata.ContentHash,
        "size":            metadata.Size,
        "mime_type":       metadata.MIMEType,
        "storage_pointer": metadata.StoragePointer,
    })
    
    evt, err := h.wal.Append(projectID, "file.uploaded", payload, nil)
    if err != nil {
        // Bytes are stored but WAL failed - orphaned bytes are acceptable
        // Log for potential cleanup but don't fail the request
        h.logger.Warn().
            Err(err).
            Str("content_hash", metadata.ContentHash).
            Msg("WAL append failed after content stored - orphaned bytes")
        http.Error(w, "metadata persistence failed", http.StatusInternalServerError)
        return
    }
    
    // 6. Return success with event ID
    response := map[string]interface{}{
        "event_id":     evt.EventID,
        "content_hash": metadata.ContentHash,
        "size":         metadata.Size,
    }
    
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(response)
}
```

## Data Models

### WAL Event Payload for File Upload

```json
{
  "event_type": "file.uploaded",
  "payload": {
    "content_hash": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "size": 1048576,
    "mime_type": "application/pdf",
    "storage_pointer": "content/e3/b0/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  },
  "metadata": {
    "filename": "document.pdf",
    "uploaded_by": "user-123"
  }
}
```

### Content Store Directory Structure

```
data/
├── content/                    # Content-addressable storage
│   ├── e3/                     # First 2 chars of hash
│   │   └── b0/                 # Next 2 chars of hash
│   │       └── e3b0c44...      # Full hash as filename
│   └── ab/
│       └── cd/
│           └── abcd1234...
├── temp/                       # Temporary upload staging
│   └── upload-*                # In-progress uploads
└── projects/                   # Existing WAL structure
    └── {project_id}/
        └── events.wal
```

### Benchmark Result Schema

```json
{
  "benchmark_id": "bench-20260114-001",
  "timestamp": "2026-01-14T10:30:00Z",
  "system": "shrikdb",
  "configuration": {
    "storage_backend": "filesystem",
    "sync_mode": "always",
    "chunk_size": 65536,
    "max_concurrent": 10
  },
  "results": {
    "throughput_mbps": 245.7,
    "latency_p50_ms": 12.3,
    "latency_p95_ms": 45.2,
    "latency_p99_ms": 89.1,
    "cpu_percent_avg": 34.5,
    "memory_mb_peak": 256
  },
  "workload": {
    "file_count": 1000,
    "file_size_bytes": 1048576,
    "concurrent_clients": 10
  }
}
```


## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Content Round-Trip Integrity

*For any* byte sequence uploaded to the Content Store, retrieving that content by its storage pointer SHALL return the exact same byte sequence.

**Validates: Requirements 1.1, 4.3, 6.1**

### Property 2: Hash Computation Correctness

*For any* byte sequence uploaded to the Content Store, the returned content hash SHALL equal the SHA-256 hash computed independently over the same bytes.

**Validates: Requirements 1.2**

### Property 3: WAL Contains Metadata Only

*For any* WAL event of type "file.uploaded", the serialized event size SHALL be bounded by a constant (e.g., 4KB) regardless of the original file size, and the payload SHALL contain only content_hash, size, mime_type, and storage_pointer fields.

**Validates: Requirements 1.3, 1.4**

### Property 4: Idempotent Content-Addressable Writes

*For any* byte sequence uploaded multiple times, all uploads SHALL return the same content hash and storage pointer, and the backing store SHALL contain exactly one copy of the content.

**Validates: Requirements 1.5, 2.3**

### Property 5: Durability Ordering Invariant

*For any* WAL event of type "file.uploaded", the content file referenced by the storage pointer SHALL exist in the Content Store. (WAL entry implies content exists)

**Validates: Requirements 2.2**

### Property 6: Storage Failure Propagation

*For any* upload where the Content Store fails to persist bytes, the API SHALL return an error AND no WAL event SHALL be created for that upload.

**Validates: Requirements 2.1, 2.4**

### Property 7: Bounded Memory Streaming

*For any* file upload of size N bytes, the peak memory usage during upload SHALL be bounded by a constant M (e.g., 10MB) regardless of N.

**Validates: Requirements 3.1**

### Property 8: Backpressure Propagation

*For any* system state where the Content Store is at capacity, new upload requests SHALL receive a backpressure signal (HTTP 503 or blocked) rather than unbounded queuing.

**Validates: Requirements 3.2**

### Property 9: Backward API Compatibility

*For any* valid API request that succeeded before this feature, the same request SHALL succeed after this feature with a response that is a superset of the original response schema.

**Validates: Requirements 4.1, 4.2**

### Property 10: Range Request Correctness

*For any* stored content of size N and any valid byte range [start, end] where 0 ≤ start ≤ end < N, a range request SHALL return exactly bytes[start:end+1] of the original content.

**Validates: Requirements 6.4**

### Property 11: Integrity Verification Correctness

*For any* stored content, when integrity verification is enabled, retrieval SHALL succeed if and only if the current content hash matches the stored hash.

**Validates: Requirements 7.1**

## Error Handling

### Upload Errors

| Error Condition | HTTP Status | Response | Recovery |
|----------------|-------------|----------|----------|
| Content Store write failure | 500 | `{"error": "storage_failed"}` | Retry upload |
| WAL write failure (after content stored) | 500 | `{"error": "metadata_failed"}` | Retry upload (idempotent) |
| Backpressure limit reached | 503 | `{"error": "service_overloaded", "retry_after": 5}` | Exponential backoff |
| Invalid request | 400 | `{"error": "invalid_request", "details": "..."}` | Fix request |
| Authentication failure | 401 | `{"error": "unauthorized"}` | Re-authenticate |

### Retrieval Errors

| Error Condition | HTTP Status | Response | Recovery |
|----------------|-------------|----------|----------|
| Content not found | 404 | `{"error": "content_not_found"}` | Check event ID |
| Content corrupted | 500 | `{"error": "content_corrupted", "hash_mismatch": true}` | Report to operator |
| Invalid range | 416 | `{"error": "range_not_satisfiable"}` | Fix range header |

### Orphaned Content Handling

Orphaned bytes (content stored but no WAL entry) are acceptable and handled by:
1. Background garbage collection scans content directory
2. Content not referenced by any WAL event after grace period (24h) is deleted
3. Metrics track orphaned content count and size

## Testing Strategy

### Property-Based Testing

Use Go's `testing/quick` or `gopter` for property-based tests with minimum 100 iterations per property.

**Test Configuration:**
```go
// Property test configuration
const (
    PropertyTestIterations = 100
    MaxFileSizeBytes      = 10 * 1024 * 1024  // 10MB for tests
    MinFileSizeBytes      = 1
)
```

**Generator Strategy:**
- Generate random byte sequences of varying sizes (1B to 10MB)
- Generate random MIME types from common set
- Generate random project IDs following naming rules
- Generate random byte ranges for range request tests

### Unit Tests

Unit tests focus on:
- Edge cases: empty files, single byte, exact chunk boundaries
- Error conditions: disk full, permission denied, corrupted content
- Boundary conditions: max file size, max concurrent uploads

### Benchmark Suite

```go
// BenchmarkConfig defines benchmark parameters
type BenchmarkConfig struct {
    FileSizes       []int64   // e.g., [1KB, 1MB, 10MB, 100MB]
    ConcurrentClients []int   // e.g., [1, 5, 10, 20]
    Duration        time.Duration
    WarmupDuration  time.Duration
}

// BenchmarkResult captures all required metrics
type BenchmarkResult struct {
    System          string
    ThroughputMBps  float64
    LatencyP50Ms    float64
    LatencyP95Ms    float64
    LatencyP99Ms    float64
    CPUPercentAvg   float64
    MemoryMBPeak    float64
    ErrorRate       float64
}
```

### Comparative Benchmark Requirements

1. **MongoDB GridFS**: Single-node MongoDB with GridFS, same hardware
2. **PostgreSQL Large Objects**: Single-node PostgreSQL with lo_* functions
3. **Local FS Baseline**: Direct filesystem writes without ShrikDB overhead

All benchmarks must:
- Use identical hardware and OS configuration
- Use identical file sizes and concurrency levels
- Report raw numbers without interpretation
- Include error bars / standard deviation
