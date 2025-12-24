// Package projection provides event processing for document projections.
// This processes events to maintain document state in the document store.
package projection

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"shrikdb/pkg/docstore"
	"shrikdb/pkg/event"

	"github.com/rs/zerolog"
)

// Engine processes events to maintain document projections.
type Engine struct {
	store   docstore.Store
	logger  zerolog.Logger
	metrics *Metrics
}

// Metrics tracks projection engine performance.
type Metrics struct {
	DocumentsCount     int64         `json:"documents_count"`
	ProjectionLag      time.Duration `json:"projection_lag"`
	EventsProcessed    uint64        `json:"events_processed"`
	ProcessingRate     float64       `json:"processing_rate"` // events per second
	LastProcessedEvent string        `json:"last_processed_event"`
	RebuildTime        time.Duration `json:"last_rebuild_time"`
	ProcessingErrors   uint64        `json:"processing_errors"`
}

// EventHandler defines the interface for handling document events.
type EventHandler interface {
	HandleDocumentCreated(ctx context.Context, event *event.Event) error
	HandleDocumentUpdated(ctx context.Context, event *event.Event) error
	HandleDocumentDeleted(ctx context.Context, event *event.Event) error
}

// DocumentCreatedPayload represents the payload for document.created events.
type DocumentCreatedPayload struct {
	DocumentID string                 `json:"document_id"`
	Collection string                 `json:"collection"`
	Content    map[string]interface{} `json:"content"`
}

// DocumentUpdatedPayload represents the payload for document.updated events.
type DocumentUpdatedPayload struct {
	DocumentID string                 `json:"document_id"`
	Updates    map[string]interface{} `json:"updates"`
	Version    uint64                 `json:"version,omitempty"`
}

// DocumentDeletedPayload represents the payload for document.deleted events.
type DocumentDeletedPayload struct {
	DocumentID string `json:"document_id"`
	Collection string `json:"collection"`
}

// New creates a new projection engine.
func New(store docstore.Store, logger zerolog.Logger) *Engine {
	return &Engine{
		store:   store,
		logger:  logger.With().Str("component", "projection").Logger(),
		metrics: &Metrics{},
	}
}

// ProcessEvent processes a single event and updates the projection.
func (e *Engine) ProcessEvent(ctx context.Context, evt *event.Event) error {
	start := time.Now()
	
	e.logger.Debug().
		Str("event_id", evt.EventID).
		Str("event_type", evt.EventType).
		Uint64("sequence", evt.SequenceNumber).
		Msg("processing event")
	
	var err error
	
	switch evt.EventType {
	case "document.created":
		err = e.HandleDocumentCreated(ctx, evt)
	case "document.updated":
		err = e.HandleDocumentUpdated(ctx, evt)
	case "document.deleted":
		err = e.HandleDocumentDeleted(ctx, evt)
	default:
		// Ignore non-document events
		e.logger.Debug().
			Str("event_type", evt.EventType).
			Msg("ignoring non-document event")
		return nil
	}
	
	// Update metrics
	e.metrics.EventsProcessed++
	e.metrics.LastProcessedEvent = evt.EventID
	e.metrics.ProjectionLag = time.Since(evt.Timestamp)
	
	if err != nil {
		e.metrics.ProcessingErrors++
		e.logger.Error().
			Err(err).
			Str("event_id", evt.EventID).
			Str("event_type", evt.EventType).
			Msg("failed to process event")
		return fmt.Errorf("failed to process event %s: %w", evt.EventID, err)
	}
	
	processingTime := time.Since(start)
	e.logger.Debug().
		Str("event_id", evt.EventID).
		Dur("processing_time", processingTime).
		Msg("event processed successfully")
	
	return nil
}

// HandleDocumentCreated processes document.created events.
func (e *Engine) HandleDocumentCreated(ctx context.Context, evt *event.Event) error {
	var payload DocumentCreatedPayload
	if err := json.Unmarshal(evt.Payload, &payload); err != nil {
		return fmt.Errorf("failed to unmarshal document.created payload: %w", err)
	}
	
	// Validate payload
	if payload.DocumentID == "" {
		return fmt.Errorf("document_id is required")
	}
	if payload.Collection == "" {
		return fmt.Errorf("collection is required")
	}
	if payload.Content == nil {
		return fmt.Errorf("content is required")
	}
	
	// Create document
	doc := &docstore.Document{
		ID:         payload.DocumentID,
		ProjectID:  evt.ProjectID,
		Collection: payload.Collection,
		Content:    payload.Content,
		EventID:    evt.EventID,
	}
	
	if err := e.store.CreateDocument(ctx, doc); err != nil {
		return fmt.Errorf("failed to create document in store: %w", err)
	}
	
	e.logger.Info().
		Str("doc_id", payload.DocumentID).
		Str("collection", payload.Collection).
		Str("project_id", evt.ProjectID).
		Msg("document created from event")
	
	return nil
}

// HandleDocumentUpdated processes document.updated events.
func (e *Engine) HandleDocumentUpdated(ctx context.Context, evt *event.Event) error {
	var payload DocumentUpdatedPayload
	if err := json.Unmarshal(evt.Payload, &payload); err != nil {
		return fmt.Errorf("failed to unmarshal document.updated payload: %w", err)
	}
	
	// Validate payload
	if payload.DocumentID == "" {
		return fmt.Errorf("document_id is required")
	}
	if len(payload.Updates) == 0 {
		return fmt.Errorf("updates are required")
	}
	
	// Update document
	if err := e.store.UpdateDocument(ctx, payload.DocumentID, payload.Updates); err != nil {
		return fmt.Errorf("failed to update document in store: %w", err)
	}
	
	e.logger.Info().
		Str("doc_id", payload.DocumentID).
		Str("project_id", evt.ProjectID).
		Int("update_fields", len(payload.Updates)).
		Msg("document updated from event")
	
	return nil
}

// HandleDocumentDeleted processes document.deleted events.
func (e *Engine) HandleDocumentDeleted(ctx context.Context, evt *event.Event) error {
	var payload DocumentDeletedPayload
	if err := json.Unmarshal(evt.Payload, &payload); err != nil {
		return fmt.Errorf("failed to unmarshal document.deleted payload: %w", err)
	}
	
	// Validate payload
	if payload.DocumentID == "" {
		return fmt.Errorf("document_id is required")
	}
	
	// Delete document
	if err := e.store.DeleteDocument(ctx, payload.DocumentID); err != nil {
		// If document doesn't exist, that's okay - it might have been deleted already
		if err == docstore.ErrDocumentNotFound {
			e.logger.Warn().
				Str("doc_id", payload.DocumentID).
				Msg("document already deleted")
			return nil
		}
		return fmt.Errorf("failed to delete document from store: %w", err)
	}
	
	e.logger.Info().
		Str("doc_id", payload.DocumentID).
		Str("project_id", evt.ProjectID).
		Msg("document deleted from event")
	
	return nil
}

// RebuildFromEvents rebuilds projections from a sequence of events.
func (e *Engine) RebuildFromEvents(ctx context.Context, projectID string, events []*event.Event) error {
	start := time.Now()
	
	e.logger.Info().
		Str("project_id", projectID).
		Int("event_count", len(events)).
		Msg("starting projection rebuild")
	
	// Clear existing projections for this project
	if err := e.store.Clear(ctx, projectID); err != nil {
		return fmt.Errorf("failed to clear existing projections: %w", err)
	}
	
	// Process events in order
	processed := 0
	for _, evt := range events {
		if evt.ProjectID != projectID {
			continue // Skip events from other projects
		}
		
		if err := e.ProcessEvent(ctx, evt); err != nil {
			e.logger.Error().
				Err(err).
				Str("event_id", evt.EventID).
				Int("processed", processed).
				Msg("rebuild failed at event")
			return fmt.Errorf("rebuild failed at event %s: %w", evt.EventID, err)
		}
		
		processed++
		
		// Log progress for large rebuilds
		if processed%1000 == 0 {
			e.logger.Info().
				Int("processed", processed).
				Int("total", len(events)).
				Msg("rebuild progress")
		}
	}
	
	duration := time.Since(start)
	e.metrics.RebuildTime = duration
	
	e.logger.Info().
		Str("project_id", projectID).
		Int("events_processed", processed).
		Dur("duration", duration).
		Msg("projection rebuild completed")
	
	return nil
}

// GetMetrics returns current projection metrics.
func (e *Engine) GetMetrics() *Metrics {
	// Update documents count from store
	// Note: This is a simplified implementation. In production, you might want to cache this.
	return &Metrics{
		DocumentsCount:     e.metrics.DocumentsCount,
		ProjectionLag:      e.metrics.ProjectionLag,
		EventsProcessed:    e.metrics.EventsProcessed,
		ProcessingRate:     e.metrics.ProcessingRate,
		LastProcessedEvent: e.metrics.LastProcessedEvent,
		RebuildTime:        e.metrics.RebuildTime,
		ProcessingErrors:   e.metrics.ProcessingErrors,
	}
}

// UpdateDocumentsCount updates the documents count metric for a project.
func (e *Engine) UpdateDocumentsCount(ctx context.Context, projectID string) error {
	stats, err := e.store.GetStats(ctx, projectID)
	if err != nil {
		return fmt.Errorf("failed to get store stats: %w", err)
	}
	
	e.metrics.DocumentsCount = stats.DocumentCount
	return nil
}

// Close shuts down the projection engine.
func (e *Engine) Close() error {
	e.logger.Info().Msg("shutting down projection engine")
	return nil
}