// Package wal implements the Write-Ahead Log for ShrikDB.
// This is the durable, append-only event log that forms the spine of the system.
//
// Design decisions:
// - Sequential disk writes only (optimal for HDDs and SSDs)
// - fsync after each write for durability (configurable for performance)
// - Human-readable format (JSON lines) for debuggability
// - Per-project isolation via separate log files
// - Crash-safe: partial writes are detected and truncated on recovery
package wal

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"shrikdb/pkg/event"

	"github.com/rs/zerolog"
)

// WAL errors
var (
	ErrWALClosed       = errors.New("WAL is closed")
	ErrCorruptEntry    = errors.New("corrupt WAL entry detected")
	ErrPartialWrite    = errors.New("partial write detected, truncating")
	ErrSequenceGap     = errors.New("sequence number gap detected")
	ErrSequenceReverse = errors.New("sequence number went backwards")
)

// Config holds WAL configuration.
type Config struct {
	// DataDir is the root directory for all WAL files
	DataDir string

	// SyncMode controls fsync behavior
	// "always" - fsync after every write (safest, slowest)
	// "batch"  - fsync after N writes or T duration (balanced)
	// "none"   - no fsync, OS decides (fastest, least safe)
	SyncMode string

	// BatchSize for "batch" sync mode
	BatchSize int

	// BatchTimeout for "batch" sync mode
	BatchTimeout time.Duration

	// MaxFileSize triggers rotation (0 = no rotation)
	MaxFileSize int64
}

// DefaultConfig returns production-safe defaults.
func DefaultConfig(dataDir string) Config {
	return Config{
		DataDir:      dataDir,
		SyncMode:     "always", // Production default: durability over speed
		BatchSize:    100,
		BatchTimeout: 100 * time.Millisecond,
		MaxFileSize:  100 * 1024 * 1024, // 100MB per file
	}
}

// WAL is the Write-Ahead Log implementation.
type WAL struct {
	config Config
	logger zerolog.Logger

	mu       sync.RWMutex
	files    map[string]*projectLog // projectID -> log
	closed   bool
	metrics  *Metrics
}

// projectLog manages the WAL for a single project.
type projectLog struct {
	projectID      string
	file           *os.File
	writer         *bufio.Writer
	currentSeq     uint64
	lastEventHash  string
	lastTimestamp  time.Time
	bytesWritten   int64
	pendingWrites  int
	mu             sync.Mutex
}

// Metrics tracks WAL operations for observability.
type Metrics struct {
	mu              sync.RWMutex
	EventsAppended  uint64
	BytesWritten    uint64
	SyncsPerformed  uint64
	ErrorsEncountered uint64
	LastAppendTime  time.Time
	AppendLatencyNs int64
}


// New creates a new WAL instance.
func New(config Config, logger zerolog.Logger) (*WAL, error) {
	// Ensure data directory exists
	if err := os.MkdirAll(config.DataDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create data directory: %w", err)
	}

	w := &WAL{
		config:  config,
		logger:  logger.With().Str("component", "wal").Logger(),
		files:   make(map[string]*projectLog),
		metrics: &Metrics{},
	}

	w.logger.Info().
		Str("data_dir", config.DataDir).
		Str("sync_mode", config.SyncMode).
		Msg("WAL initialized")

	return w, nil
}

// Append writes an event to the WAL.
// This is the critical path - must be crash-safe.
func (w *WAL) Append(projectID, eventType string, payload json.RawMessage, metadata map[string]string) (*event.Event, error) {
	start := time.Now()

	w.mu.RLock()
	if w.closed {
		w.mu.RUnlock()
		return nil, ErrWALClosed
	}
	w.mu.RUnlock()

	// Get or create project log
	plog, err := w.getOrCreateProjectLog(projectID)
	if err != nil {
		w.recordError()
		return nil, err
	}

	plog.mu.Lock()
	defer plog.mu.Unlock()

	// Assign sequence number (server-side, monotonic)
	nextSeq := plog.currentSeq + 1

	// Create event with server-assigned fields
	evt, err := event.NewEvent(projectID, eventType, payload, nextSeq, plog.lastEventHash, metadata)
	if err != nil {
		w.recordError()
		return nil, fmt.Errorf("failed to create event: %w", err)
	}

	// Ensure monotonic timestamp
	if !evt.Timestamp.After(plog.lastTimestamp) {
		evt.Timestamp = plog.lastTimestamp.Add(time.Nanosecond)
	}

	// Serialize event
	data, err := evt.Serialize()
	if err != nil {
		w.recordError()
		return nil, fmt.Errorf("failed to serialize event: %w", err)
	}

	// Write to WAL (append newline for JSON lines format)
	data = append(data, '\n')

	n, err := plog.writer.Write(data)
	if err != nil {
		w.recordError()
		return nil, fmt.Errorf("failed to write to WAL: %w", err)
	}

	// Flush buffer to OS
	if err := plog.writer.Flush(); err != nil {
		w.recordError()
		return nil, fmt.Errorf("failed to flush WAL: %w", err)
	}

	// fsync based on mode
	if err := w.maybeSync(plog); err != nil {
		w.recordError()
		return nil, fmt.Errorf("failed to sync WAL: %w", err)
	}

	// Update state AFTER successful write
	plog.currentSeq = nextSeq
	plog.lastEventHash = evt.ComputeEventHash()
	plog.lastTimestamp = evt.Timestamp
	plog.bytesWritten += int64(n)
	plog.pendingWrites++

	// Record metrics
	w.recordAppend(int64(n), time.Since(start))

	w.logger.Debug().
		Str("project_id", projectID).
		Str("event_id", evt.EventID).
		Uint64("sequence", nextSeq).
		Msg("event appended")

	return evt, nil
}

// maybeSync performs fsync based on configuration.
func (w *WAL) maybeSync(plog *projectLog) error {
	switch w.config.SyncMode {
	case "always":
		if err := plog.file.Sync(); err != nil {
			return err
		}
		w.metrics.mu.Lock()
		w.metrics.SyncsPerformed++
		w.metrics.mu.Unlock()

	case "batch":
		if plog.pendingWrites >= w.config.BatchSize {
			if err := plog.file.Sync(); err != nil {
				return err
			}
			plog.pendingWrites = 0
			w.metrics.mu.Lock()
			w.metrics.SyncsPerformed++
			w.metrics.mu.Unlock()
		}

	case "none":
		// No sync, rely on OS
	}
	return nil
}

// getOrCreateProjectLog returns the log for a project, creating if needed.
func (w *WAL) getOrCreateProjectLog(projectID string) (*projectLog, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if plog, exists := w.files[projectID]; exists {
		return plog, nil
	}

	// Create project directory
	projectDir := filepath.Join(w.config.DataDir, "projects", projectID)
	if err := os.MkdirAll(projectDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create project directory: %w", err)
	}

	// Open WAL file (append mode, create if not exists)
	walPath := filepath.Join(projectDir, "events.wal")
	file, err := os.OpenFile(walPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return nil, fmt.Errorf("failed to open WAL file: %w", err)
	}

	plog := &projectLog{
		projectID: projectID,
		file:      file,
		writer:    bufio.NewWriter(file),
	}

	// Recover state from existing WAL
	if err := w.recoverProjectState(plog, projectDir); err != nil {
		file.Close()
		return nil, fmt.Errorf("failed to recover project state: %w", err)
	}

	w.files[projectID] = plog

	w.logger.Info().
		Str("project_id", projectID).
		Uint64("recovered_seq", plog.currentSeq).
		Msg("project log opened")

	return plog, nil
}


// recoverProjectState reads existing WAL to recover sequence number and last hash.
func (w *WAL) recoverProjectState(plog *projectLog, projectDir string) error {
	walPath := filepath.Join(projectDir, "events.wal")

	// Open for reading
	readFile, err := os.Open(walPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil // New project, no recovery needed
		}
		return err
	}
	defer readFile.Close()

	scanner := bufio.NewScanner(readFile)
	// Increase buffer for large events
	scanner.Buffer(make([]byte, 1024*1024), 10*1024*1024)

	var lastEvent *event.Event
	lineNum := 0

	for scanner.Scan() {
		lineNum++
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		evt, err := event.Deserialize(line)
		if err != nil {
			w.logger.Warn().
				Int("line", lineNum).
				Err(err).
				Msg("corrupt entry detected during recovery")
			// Truncate from this point
			return w.truncateCorruptEntries(plog, projectDir, lineNum)
		}

		// Verify integrity
		if err := evt.VerifyIntegrity(); err != nil {
			w.logger.Warn().
				Int("line", lineNum).
				Str("event_id", evt.EventID).
				Err(err).
				Msg("integrity check failed during recovery")
			return w.truncateCorruptEntries(plog, projectDir, lineNum)
		}

		// Verify sequence ordering
		if lastEvent != nil && evt.SequenceNumber != lastEvent.SequenceNumber+1 {
			w.logger.Error().
				Uint64("expected", lastEvent.SequenceNumber+1).
				Uint64("got", evt.SequenceNumber).
				Msg("sequence gap detected")
			// This is a critical error - log but continue
		}

		lastEvent = evt
	}

	if err := scanner.Err(); err != nil {
		return fmt.Errorf("error reading WAL: %w", err)
	}

	if lastEvent != nil {
		plog.currentSeq = lastEvent.SequenceNumber
		plog.lastEventHash = lastEvent.ComputeEventHash()
		plog.lastTimestamp = lastEvent.Timestamp
	}

	w.logger.Info().
		Str("project_id", plog.projectID).
		Int("events_recovered", lineNum).
		Uint64("last_seq", plog.currentSeq).
		Msg("WAL recovery complete")

	return nil
}

// truncateCorruptEntries removes corrupt entries from the end of WAL.
func (w *WAL) truncateCorruptEntries(plog *projectLog, projectDir string, fromLine int) error {
	walPath := filepath.Join(projectDir, "events.wal")

	// Read valid entries
	readFile, err := os.Open(walPath)
	if err != nil {
		return err
	}

	var validEntries [][]byte
	scanner := bufio.NewScanner(readFile)
	scanner.Buffer(make([]byte, 1024*1024), 10*1024*1024)

	lineNum := 0
	var lastEvent *event.Event

	for scanner.Scan() && lineNum < fromLine-1 {
		lineNum++
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		evt, err := event.Deserialize(line)
		if err != nil {
			break
		}

		validEntries = append(validEntries, append([]byte{}, line...))
		lastEvent = evt
	}
	readFile.Close()

	// Rewrite WAL with only valid entries
	tmpPath := walPath + ".tmp"
	tmpFile, err := os.Create(tmpPath)
	if err != nil {
		return err
	}

	for _, entry := range validEntries {
		tmpFile.Write(entry)
		tmpFile.Write([]byte{'\n'})
	}

	if err := tmpFile.Sync(); err != nil {
		tmpFile.Close()
		return err
	}
	tmpFile.Close()

	// Atomic rename
	if err := os.Rename(tmpPath, walPath); err != nil {
		return err
	}

	if lastEvent != nil {
		plog.currentSeq = lastEvent.SequenceNumber
		plog.lastEventHash = lastEvent.ComputeEventHash()
		plog.lastTimestamp = lastEvent.Timestamp
	}

	w.logger.Warn().
		Int("truncated_from_line", fromLine).
		Int("valid_entries", len(validEntries)).
		Msg("WAL truncated due to corruption")

	return nil
}

// ReadEvents reads events from a project's WAL starting from an offset.
func (w *WAL) ReadEvents(projectID string, fromSequence uint64) ([]*event.Event, error) {
	w.mu.RLock()
	if w.closed {
		w.mu.RUnlock()
		return nil, ErrWALClosed
	}
	w.mu.RUnlock()

	projectDir := filepath.Join(w.config.DataDir, "projects", projectID)
	walPath := filepath.Join(projectDir, "events.wal")

	file, err := os.Open(walPath)
	if err != nil {
		if os.IsNotExist(err) {
			return []*event.Event{}, nil
		}
		return nil, fmt.Errorf("failed to open WAL for reading: %w", err)
	}
	defer file.Close()

	var events []*event.Event
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 1024*1024), 10*1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		evt, err := event.Deserialize(line)
		if err != nil {
			w.logger.Warn().Err(err).Msg("skipping corrupt entry during read")
			continue
		}

		if evt.SequenceNumber >= fromSequence {
			events = append(events, evt)
		}
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("error reading WAL: %w", err)
	}

	return events, nil
}

// ReadEventsStream reads events and sends them to a channel (for large datasets).
func (w *WAL) ReadEventsStream(projectID string, fromSequence uint64, ch chan<- *event.Event) error {
	defer close(ch)

	projectDir := filepath.Join(w.config.DataDir, "projects", projectID)
	walPath := filepath.Join(projectDir, "events.wal")

	file, err := os.Open(walPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("failed to open WAL for streaming: %w", err)
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 1024*1024), 10*1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		evt, err := event.Deserialize(line)
		if err != nil {
			continue
		}

		if evt.SequenceNumber >= fromSequence {
			ch <- evt
		}
	}

	return scanner.Err()
}

// Close closes all WAL files gracefully.
func (w *WAL) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.closed {
		return nil
	}

	var errs []error
	for projectID, plog := range w.files {
		plog.mu.Lock()
		if err := plog.writer.Flush(); err != nil {
			errs = append(errs, fmt.Errorf("flush %s: %w", projectID, err))
		}
		if err := plog.file.Sync(); err != nil {
			errs = append(errs, fmt.Errorf("sync %s: %w", projectID, err))
		}
		if err := plog.file.Close(); err != nil {
			errs = append(errs, fmt.Errorf("close %s: %w", projectID, err))
		}
		plog.mu.Unlock()
	}

	w.closed = true
	w.logger.Info().Msg("WAL closed")

	if len(errs) > 0 {
		return fmt.Errorf("errors during close: %v", errs)
	}
	return nil
}

// GetMetrics returns current WAL metrics.
func (w *WAL) GetMetrics() Metrics {
	w.metrics.mu.RLock()
	defer w.metrics.mu.RUnlock()
	return *w.metrics
}

func (w *WAL) recordAppend(bytes int64, latency time.Duration) {
	w.metrics.mu.Lock()
	defer w.metrics.mu.Unlock()
	w.metrics.EventsAppended++
	w.metrics.BytesWritten += uint64(bytes)
	w.metrics.LastAppendTime = time.Now()
	w.metrics.AppendLatencyNs = latency.Nanoseconds()
}

func (w *WAL) recordError() {
	w.metrics.mu.Lock()
	defer w.metrics.mu.Unlock()
	w.metrics.ErrorsEncountered++
}

// GetProjectSequence returns the current sequence number for a project.
func (w *WAL) GetProjectSequence(projectID string) (uint64, error) {
	w.mu.RLock()
	plog, exists := w.files[projectID]
	w.mu.RUnlock()

	if exists {
		plog.mu.Lock()
		seq := plog.currentSeq
		plog.mu.Unlock()
		return seq, nil
	}

	// Project not loaded, read from disk
	events, err := w.ReadEvents(projectID, 0)
	if err != nil {
		return 0, err
	}

	if len(events) == 0 {
		return 0, nil
	}

	return events[len(events)-1].SequenceNumber, nil
}
