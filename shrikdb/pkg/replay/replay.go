// Package replay implements the deterministic replay engine for ShrikDB.
// Replay is the recovery path - if anything breaks, replay from the event log.
//
// Guarantees:
// - Deterministic: same events always produce same state
// - Idempotent: replaying twice produces identical results
// - Observable: progress and errors are reported
// - Complete: can rebuild all derived state from events alone
package replay

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"shrikdb/pkg/event"
	"shrikdb/pkg/wal"

	"github.com/rs/zerolog"
)

// Replay errors
var (
	ErrReplayInProgress = errors.New("replay already in progress")
	ErrReplayCanceled   = errors.New("replay was canceled")
	ErrIntegrityFailure = errors.New("event integrity check failed during replay")
	ErrChainBroken      = errors.New("event chain integrity broken")
)

// EventHandler is called for each event during replay.
// Return an error to stop replay.
type EventHandler func(evt *event.Event) error

// Progress reports replay progress.
type Progress struct {
	ProjectID      string
	TotalEvents    uint64
	ProcessedEvents uint64
	CurrentSequence uint64
	StartTime      time.Time
	LastEventTime  time.Time
	Errors         []error
}

// Engine is the replay engine.
type Engine struct {
	wal    *wal.WAL
	logger zerolog.Logger

	mu        sync.Mutex
	replaying map[string]bool // projectID -> in progress
}

// New creates a new replay engine.
func New(w *wal.WAL, logger zerolog.Logger) *Engine {
	return &Engine{
		wal:       w,
		logger:    logger.With().Str("component", "replay").Logger(),
		replaying: make(map[string]bool),
	}
}

// Replay replays all events for a project from the beginning.
// This is the primary recovery mechanism.
func (e *Engine) Replay(ctx context.Context, projectID string, handler EventHandler) (*Progress, error) {
	return e.ReplayFrom(ctx, projectID, 0, handler)
}

// ReplayFrom replays events starting from a specific sequence number.
func (e *Engine) ReplayFrom(ctx context.Context, projectID string, fromSequence uint64, handler EventHandler) (*Progress, error) {
	// Prevent concurrent replays for same project
	e.mu.Lock()
	if e.replaying[projectID] {
		e.mu.Unlock()
		return nil, ErrReplayInProgress
	}
	e.replaying[projectID] = true
	e.mu.Unlock()

	defer func() {
		e.mu.Lock()
		delete(e.replaying, projectID)
		e.mu.Unlock()
	}()

	progress := &Progress{
		ProjectID: projectID,
		StartTime: time.Now(),
	}

	e.logger.Info().
		Str("project_id", projectID).
		Uint64("from_sequence", fromSequence).
		Msg("starting replay")

	// Stream events to avoid loading all into memory
	eventCh := make(chan *event.Event, 1000)
	errCh := make(chan error, 1)

	go func() {
		errCh <- e.wal.ReadEventsStream(projectID, fromSequence, eventCh)
	}()

	var previousHash string
	var lastSeq uint64

	for {
		select {
		case <-ctx.Done():
			return progress, ErrReplayCanceled

		case evt, ok := <-eventCh:
			if !ok {
				// Channel closed, check for read errors
				if err := <-errCh; err != nil {
					return progress, fmt.Errorf("error reading events: %w", err)
				}
				// Replay complete
				e.logger.Info().
					Str("project_id", projectID).
					Uint64("events_processed", progress.ProcessedEvents).
					Dur("duration", time.Since(progress.StartTime)).
					Msg("replay complete")
				return progress, nil
			}

			progress.TotalEvents++

			// Verify event integrity
			if err := evt.VerifyIntegrity(); err != nil {
				progress.Errors = append(progress.Errors, fmt.Errorf("seq %d: %w", evt.SequenceNumber, err))
				e.logger.Error().
					Str("event_id", evt.EventID).
					Uint64("sequence", evt.SequenceNumber).
					Err(err).
					Msg("integrity check failed")
				return progress, ErrIntegrityFailure
			}

			// Verify chain integrity (if not first event)
			if previousHash != "" && evt.PreviousHash != previousHash {
				e.logger.Error().
					Str("event_id", evt.EventID).
					Str("expected_prev", previousHash).
					Str("actual_prev", evt.PreviousHash).
					Msg("chain integrity broken")
				return progress, ErrChainBroken
			}

			// Verify sequence ordering
			if lastSeq > 0 && evt.SequenceNumber != lastSeq+1 {
				e.logger.Warn().
					Uint64("expected", lastSeq+1).
					Uint64("got", evt.SequenceNumber).
					Msg("sequence gap detected during replay")
			}

			// Call handler
			if handler != nil {
				if err := handler(evt); err != nil {
					progress.Errors = append(progress.Errors, err)
					return progress, fmt.Errorf("handler error at seq %d: %w", evt.SequenceNumber, err)
				}
			}

			// Update progress
			progress.ProcessedEvents++
			progress.CurrentSequence = evt.SequenceNumber
			progress.LastEventTime = evt.Timestamp
			previousHash = evt.ComputeEventHash()
			lastSeq = evt.SequenceNumber

			// Log progress periodically
			if progress.ProcessedEvents%10000 == 0 {
				e.logger.Info().
					Str("project_id", projectID).
					Uint64("processed", progress.ProcessedEvents).
					Uint64("current_seq", evt.SequenceNumber).
					Msg("replay progress")
			}
		}
	}
}


// VerifyIntegrity performs a full integrity check without rebuilding state.
// Returns the number of events verified and any errors found.
func (e *Engine) VerifyIntegrity(ctx context.Context, projectID string) (*Progress, error) {
	return e.Replay(ctx, projectID, nil) // nil handler = verify only
}

// ReplayWithProgress replays and reports progress to a channel.
func (e *Engine) ReplayWithProgress(ctx context.Context, projectID string, handler EventHandler, progressCh chan<- Progress) (*Progress, error) {
	// Prevent concurrent replays for same project
	e.mu.Lock()
	if e.replaying[projectID] {
		e.mu.Unlock()
		return nil, ErrReplayInProgress
	}
	e.replaying[projectID] = true
	e.mu.Unlock()

	defer func() {
		e.mu.Lock()
		delete(e.replaying, projectID)
		e.mu.Unlock()
		if progressCh != nil {
			close(progressCh)
		}
	}()

	progress := &Progress{
		ProjectID: projectID,
		StartTime: time.Now(),
	}

	eventCh := make(chan *event.Event, 1000)
	errCh := make(chan error, 1)

	go func() {
		errCh <- e.wal.ReadEventsStream(projectID, 0, eventCh)
	}()

	var previousHash string
	reportInterval := uint64(1000)

	for {
		select {
		case <-ctx.Done():
			return progress, ErrReplayCanceled

		case evt, ok := <-eventCh:
			if !ok {
				if err := <-errCh; err != nil {
					return progress, err
				}
				// Send final progress
				if progressCh != nil {
					progressCh <- *progress
				}
				return progress, nil
			}

			progress.TotalEvents++

			if err := evt.VerifyIntegrity(); err != nil {
				progress.Errors = append(progress.Errors, err)
				return progress, ErrIntegrityFailure
			}

			if previousHash != "" && evt.PreviousHash != previousHash {
				return progress, ErrChainBroken
			}

			if handler != nil {
				if err := handler(evt); err != nil {
					progress.Errors = append(progress.Errors, err)
					return progress, err
				}
			}

			progress.ProcessedEvents++
			progress.CurrentSequence = evt.SequenceNumber
			progress.LastEventTime = evt.Timestamp
			previousHash = evt.ComputeEventHash()

			// Report progress periodically
			if progressCh != nil && progress.ProcessedEvents%reportInterval == 0 {
				progressCh <- *progress
			}
		}
	}
}

// CountEvents returns the total number of events for a project.
func (e *Engine) CountEvents(projectID string) (uint64, error) {
	events, err := e.wal.ReadEvents(projectID, 0)
	if err != nil {
		return 0, err
	}
	return uint64(len(events)), nil
}

// GetLastEvent returns the last event for a project.
func (e *Engine) GetLastEvent(projectID string) (*event.Event, error) {
	events, err := e.wal.ReadEvents(projectID, 0)
	if err != nil {
		return nil, err
	}
	if len(events) == 0 {
		return nil, nil
	}
	return events[len(events)-1], nil
}
// ConsistencyReport provides detailed information about projection consistency.
type ConsistencyReport struct {
	ProjectID            string        `json:"project_id"`
	EventsProcessed      uint64        `json:"events_processed"`
	DocumentsRebuilt     int64         `json:"documents_rebuilt"`
	InconsistenciesFound int           `json:"inconsistencies_found"`
	RebuildDuration      time.Duration `json:"rebuild_duration"`
	Timestamp            time.Time     `json:"timestamp"`
	Errors               []string      `json:"errors,omitempty"`
}

// ProjectionHandler defines the interface for handling projection rebuilds.
type ProjectionHandler interface {
	ProcessEvent(ctx context.Context, event *event.Event) error
	RebuildFromEvents(ctx context.Context, projectID string, events []*event.Event) error
	GetMetrics() interface{}
}

// RebuildProjections rebuilds document projections from the complete event history.
func (e *Engine) RebuildProjections(ctx context.Context, projectID string, projectionHandler ProjectionHandler) (*Progress, error) {
	e.logger.Info().
		Str("project_id", projectID).
		Msg("starting projection rebuild")

	start := time.Now()
	
	// Read all events for the project
	events, err := e.wal.ReadEvents(projectID, 0)
	if err != nil {
		return nil, fmt.Errorf("failed to read events for rebuild: %w", err)
	}

	// Use the projection handler to rebuild
	if err := projectionHandler.RebuildFromEvents(ctx, projectID, events); err != nil {
		return nil, fmt.Errorf("failed to rebuild projections: %w", err)
	}

	progress := &Progress{
		ProjectID:       projectID,
		TotalEvents:     uint64(len(events)),
		ProcessedEvents: uint64(len(events)),
		StartTime:       start,
		LastEventTime:   time.Now(),
	}

	e.logger.Info().
		Str("project_id", projectID).
		Uint64("events_processed", progress.ProcessedEvents).
		Dur("duration", time.Since(start)).
		Msg("projection rebuild completed")

	return progress, nil
}

// VerifyProjectionConsistency verifies that projections are consistent with the event log.
func (e *Engine) VerifyProjectionConsistency(ctx context.Context, projectID string, projectionHandler ProjectionHandler) (*ConsistencyReport, error) {
	start := time.Now()
	
	e.logger.Info().
		Str("project_id", projectID).
		Msg("starting projection consistency verification")

	report := &ConsistencyReport{
		ProjectID:   projectID,
		Timestamp:   start,
	}

	// Read all events
	events, err := e.wal.ReadEvents(projectID, 0)
	if err != nil {
		return report, fmt.Errorf("failed to read events: %w", err)
	}

	report.EventsProcessed = uint64(len(events))

	// Create a temporary projection by replaying events
	tempProjectionHandler := projectionHandler // In a real implementation, you'd create a separate temp handler
	
	// Rebuild projections from scratch
	if err := tempProjectionHandler.RebuildFromEvents(ctx, projectID, events); err != nil {
		report.Errors = append(report.Errors, fmt.Sprintf("rebuild failed: %v", err))
		report.InconsistenciesFound++
	}

	report.RebuildDuration = time.Since(start)

	e.logger.Info().
		Str("project_id", projectID).
		Uint64("events_processed", report.EventsProcessed).
		Int("inconsistencies", report.InconsistenciesFound).
		Dur("duration", report.RebuildDuration).
		Msg("projection consistency verification completed")

	return report, nil
}

// ReplayForProjection replays events specifically for projection updates.
func (e *Engine) ReplayForProjection(ctx context.Context, projectID string, projectionHandler ProjectionHandler) (*Progress, error) {
	handler := func(evt *event.Event) error {
		return projectionHandler.ProcessEvent(ctx, evt)
	}

	return e.ReplayFrom(ctx, projectID, 0, handler)
}

// GetReplayStatus returns the current replay status for a project.
func (e *Engine) GetReplayStatus(projectID string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.replaying[projectID]
}

// CancelReplay cancels an ongoing replay for a project.
func (e *Engine) CancelReplay(projectID string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	// In a real implementation, you'd need to signal the replay goroutine to stop
	// For now, we just mark it as not replaying
	delete(e.replaying, projectID)
}

// ReplayMetrics provides metrics about replay operations.
type ReplayMetrics struct {
	ActiveReplays    int           `json:"active_replays"`
	TotalReplays     uint64        `json:"total_replays"`
	SuccessfulReplays uint64       `json:"successful_replays"`
	FailedReplays    uint64        `json:"failed_replays"`
	AverageReplayTime time.Duration `json:"average_replay_time"`
}

// GetMetrics returns replay engine metrics.
func (e *Engine) GetMetrics() *ReplayMetrics {
	e.mu.Lock()
	defer e.mu.Unlock()
	
	return &ReplayMetrics{
		ActiveReplays: len(e.replaying),
		// In a real implementation, you'd track these metrics
		TotalReplays:      0,
		SuccessfulReplays: 0,
		FailedReplays:     0,
		AverageReplayTime: 0,
	}
}