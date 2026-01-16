# Requirements Document

## Introduction

This feature implements real file content persistence for ShrikDB, enabling actual byte storage to a backing store (filesystem or object store) while preserving the WAL as the single source of truth. The system must maximize single-node and single-region performance with streaming uploads, backpressure enforcement, and strict durability guarantees.

## Glossary

- **Content_Store**: The backing storage system (filesystem or object store) that persists actual file bytes
- **Content_Hash**: SHA-256 hash of file content used for content-addressable storage and deduplication
- **Storage_Pointer**: Path or object key referencing the location of bytes in the Content_Store
- **WAL**: Write-Ahead Log that stores metadata (hash, size, MIME type, pointer) but never raw bytes
- **Streaming_Upload**: Upload mechanism that processes data in chunks without buffering the entire file in memory
- **Backpressure**: Flow control mechanism that propagates storage capacity limits from Content_Store → API → Client
- **Idempotent_Write**: Write operation that produces the same result regardless of how many times it is executed

## Requirements

### Requirement 1: Content-Addressable Byte Storage

**User Story:** As a system operator, I want file bytes persisted to a real backing store with content-addressable hashing, so that storage is deduplicated and verifiable.

#### Acceptance Criteria

1. WHEN a file is uploaded, THE Content_Store SHALL persist the raw bytes to the configured backing store (filesystem or object store)
2. WHEN a file is uploaded, THE Content_Store SHALL compute a SHA-256 hash of the file content
3. WHEN a file is stored, THE WAL SHALL record only the content hash, file size, MIME type, and storage pointer
4. THE WAL SHALL NOT contain embedded raw file bytes under any circumstances
5. WHEN a file with an existing content hash is uploaded, THE Content_Store SHALL return the existing storage pointer without re-writing bytes (deduplication)

### Requirement 2: Strict Write Durability Guarantees

**User Story:** As a developer, I want strict ordering guarantees where bytes are durable before metadata, so that I never have orphaned WAL entries pointing to missing content.

#### Acceptance Criteria

1. WHEN bytes fail to persist to Content_Store, THEN THE API SHALL fail the entire upload operation
2. THE WAL event SHALL only be written after bytes are confirmed durable in Content_Store
3. WHEN a write operation is retried with the same content, THE Content_Store SHALL produce identical results (idempotent writes via content hash)
4. IF Content_Store write succeeds but WAL write fails, THEN THE system SHALL leave orphaned bytes (acceptable) rather than orphaned WAL entries (unacceptable)

### Requirement 3: High-Performance Streaming Ingestion

**User Story:** As a developer uploading large files, I want streaming uploads without full file buffering, so that memory usage remains bounded regardless of file size.

#### Acceptance Criteria

1. WHEN a file is uploaded, THE API SHALL stream bytes directly to Content_Store without buffering the entire file in memory
2. WHEN Content_Store cannot accept more data, THE API SHALL propagate backpressure to the client
3. THE Benchmark_Suite SHALL report MB/s throughput for uploads
4. THE Benchmark_Suite SHALL report p95 and p99 latency for uploads
5. THE Benchmark_Suite SHALL report CPU and memory usage during uploads

### Requirement 4: Zero API Surface Breakage

**User Story:** As a frontend developer, I want the existing API to continue working unchanged, so that I don't need to modify my application.

#### Acceptance Criteria

1. WHEN the existing frontend makes API calls, THE API SHALL accept them without modification
2. THE API SHALL extend behavior (adding content persistence) without changing request/response schemas
3. WHEN retrieving files, THE API SHALL transparently fetch bytes from Content_Store using the storage pointer

### Requirement 5: Mandatory Comparative Benchmarks

**User Story:** As a system architect, I want comparative benchmarks against established systems, so that I can make informed decisions based on real data.

#### Acceptance Criteria

1. THE Benchmark_Suite SHALL compare performance against MongoDB GridFS (single node)
2. THE Benchmark_Suite SHALL compare performance against PostgreSQL Large Objects
3. THE Benchmark_Suite SHALL compare performance against local filesystem baseline
4. THE Benchmark_Suite SHALL publish raw numbers only without subjective claims
5. THE Benchmark_Suite SHALL measure: MB/s throughput, p95 latency, p99 latency, CPU usage, memory usage

### Requirement 6: Content Retrieval

**User Story:** As a developer, I want to retrieve file content by reference, so that I can access stored files.

#### Acceptance Criteria

1. WHEN a file is requested by ID, THE API SHALL resolve the storage pointer from WAL metadata
2. WHEN a file is requested, THE Content_Store SHALL stream bytes back to the client
3. WHEN a storage pointer references missing content, THE API SHALL return an appropriate error
4. THE Content_Store SHALL support range requests for partial content retrieval

### Requirement 7: Content Integrity Verification

**User Story:** As a system operator, I want to verify content integrity, so that I can detect corruption or tampering.

#### Acceptance Criteria

1. WHEN content is retrieved, THE Content_Store SHALL optionally verify the content hash matches the stored hash
2. IF content hash verification fails, THEN THE API SHALL return a corruption error
3. THE system SHALL provide a background integrity check capability for stored content
