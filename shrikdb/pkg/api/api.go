// Package api provides the internal API surface for ShrikDB Phase 1A.
// These are INTERNAL APIs - not exposed to external clients yet.
//
// API surface:
// - appendEvent(projectId, eventType, payload) -> Event
// - readEvents(projectId, fromOffset) -> []Event
// - replay(projectId) -> Progress
//
// All operations require authentication.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"shrikdb/pkg/auth"
	"shrikdb/pkg/docstore"
	"shrikdb/pkg/event"
	"shrikdb/pkg/projection"
	"shrikdb/pkg/query"
	"shrikdb/pkg/replay"
	"shrikdb/pkg/wal"

	"github.com/rs/zerolog"
)

// API errors
var (
	ErrUnauthorized    = errors.New("unauthorized")
	ErrInvalidRequest  = errors.New("invalid request")
	ErrProjectMismatch = errors.New("project ID mismatch")
)

// Service is the main API service.
type Service struct {
	wal              *wal.WAL
	replay           *replay.Engine
	auth             *auth.Store
	docStore         docstore.Store
	projectionEngine *projection.Engine
	queryEngine      *query.Engine
	logger           zerolog.Logger
	metrics          *Metrics
}

// Metrics tracks API operations.
type Metrics struct {
	AppendRequests   uint64
	ReadRequests     uint64
	ReplayRequests   uint64
	AuthFailures     uint64
	TotalLatencyNs   int64
}

// Config holds service configuration.
type Config struct {
	DataDir     string
	WAL         wal.Config
	DocumentDir string // Directory for document store
}

// NewService creates a new API service.
func NewService(config Config, logger zerolog.Logger) (*Service, error) {
	// Initialize WAL
	w, err := wal.New(config.WAL, logger)
	if err != nil {
		return nil, fmt.Errorf("failed to initialize WAL: %w", err)
	}

	// Initialize replay engine
	r := replay.New(w, logger)

	// Initialize auth store
	a := auth.NewStore(config.DataDir, logger)

	// Initialize document store
	docDir := config.DocumentDir
	if docDir == "" {
		docDir = config.DataDir + "/documents"
	}
	docStore, err := docstore.NewEmbeddedStore(docDir, logger)
	if err != nil {
		return nil, fmt.Errorf("failed to initialize document store: %w", err)
	}

	// Initialize projection engine
	projEngine := projection.New(docStore, logger)

	// Initialize query engine
	queryEngine := query.New(docStore, logger)

	return &Service{
		wal:              w,
		replay:           r,
		auth:             a,
		docStore:         docStore,
		projectionEngine: projEngine,
		queryEngine:      queryEngine,
		logger:           logger.With().Str("component", "api").Logger(),
		metrics:          &Metrics{},
	}, nil
}

// AppendEventRequest is the request for appending an event.
type AppendEventRequest struct {
	ClientID  string            `json:"client_id"`
	ClientKey string            `json:"client_key"`
	ProjectID string            `json:"project_id"`
	EventType string            `json:"event_type"`
	Payload   json.RawMessage   `json:"payload"`
	Metadata  map[string]string `json:"metadata,omitempty"`
}

// AppendEventResponse is the response from appending an event.
type AppendEventResponse struct {
	Event   *event.Event `json:"event"`
	Success bool         `json:"success"`
	Error   string       `json:"error,omitempty"`
}

// AppendEvent appends an event to the log.
// This is the primary write path.
func (s *Service) AppendEvent(ctx context.Context, req *AppendEventRequest) (*AppendEventResponse, error) {
	start := time.Now()
	s.metrics.AppendRequests++

	// Authenticate
	authCtx, err := s.authenticate(req.ClientID, req.ClientKey)
	if err != nil {
		s.metrics.AuthFailures++
		return &AppendEventResponse{Success: false, Error: err.Error()}, ErrUnauthorized
	}

	// Verify project ID matches authenticated project
	if req.ProjectID != "" && req.ProjectID != authCtx.ProjectID {
		return &AppendEventResponse{Success: false, Error: "project ID mismatch"}, ErrProjectMismatch
	}

	// Use authenticated project ID
	projectID := authCtx.ProjectID

	// Validate request
	if req.EventType == "" {
		return &AppendEventResponse{Success: false, Error: "event_type required"}, ErrInvalidRequest
	}
	if len(req.Payload) == 0 {
		return &AppendEventResponse{Success: false, Error: "payload required"}, ErrInvalidRequest
	}

	// Append to WAL
	evt, err := s.wal.Append(projectID, req.EventType, req.Payload, req.Metadata)
	if err != nil {
		s.logger.Error().Err(err).Str("project_id", projectID).Msg("append failed")
		return &AppendEventResponse{Success: false, Error: err.Error()}, err
	}

	s.metrics.TotalLatencyNs += time.Since(start).Nanoseconds()

	s.logger.Debug().
		Str("project_id", projectID).
		Str("event_id", evt.EventID).
		Uint64("sequence", evt.SequenceNumber).
		Msg("event appended via API")

	return &AppendEventResponse{Event: evt, Success: true}, nil
}

// ReadEventsRequest is the request for reading events.
type ReadEventsRequest struct {
	ClientID     string `json:"client_id"`
	ClientKey    string `json:"client_key"`
	ProjectID    string `json:"project_id"`
	FromSequence uint64 `json:"from_sequence"`
	Limit        int    `json:"limit,omitempty"` // 0 = no limit
}

// ReadEventsResponse is the response from reading events.
type ReadEventsResponse struct {
	Events  []*event.Event `json:"events"`
	Count   int            `json:"count"`
	Success bool           `json:"success"`
	Error   string         `json:"error,omitempty"`
}

// ReadEvents reads events from the log.
func (s *Service) ReadEvents(ctx context.Context, req *ReadEventsRequest) (*ReadEventsResponse, error) {
	start := time.Now()
	s.metrics.ReadRequests++

	// Authenticate
	authCtx, err := s.authenticate(req.ClientID, req.ClientKey)
	if err != nil {
		s.metrics.AuthFailures++
		return &ReadEventsResponse{Success: false, Error: err.Error()}, ErrUnauthorized
	}

	// Verify project ID
	if req.ProjectID != "" && req.ProjectID != authCtx.ProjectID {
		return &ReadEventsResponse{Success: false, Error: "project ID mismatch"}, ErrProjectMismatch
	}

	projectID := authCtx.ProjectID

	// Read from WAL
	events, err := s.wal.ReadEvents(projectID, req.FromSequence)
	if err != nil {
		s.logger.Error().Err(err).Str("project_id", projectID).Msg("read failed")
		return &ReadEventsResponse{Success: false, Error: err.Error()}, err
	}

	// Apply limit if specified
	if req.Limit > 0 && len(events) > req.Limit {
		events = events[:req.Limit]
	}

	s.metrics.TotalLatencyNs += time.Since(start).Nanoseconds()

	return &ReadEventsResponse{
		Events:  events,
		Count:   len(events),
		Success: true,
	}, nil
}


// ReplayRequest is the request for replaying events.
type ReplayRequest struct {
	ClientID     string `json:"client_id"`
	ClientKey    string `json:"client_key"`
	ProjectID    string `json:"project_id"`
	FromSequence uint64 `json:"from_sequence,omitempty"`
	VerifyOnly   bool   `json:"verify_only,omitempty"` // Just verify, don't rebuild
}

// ReplayResponse is the response from replay.
type ReplayResponse struct {
	Progress *replay.Progress `json:"progress"`
	Success  bool             `json:"success"`
	Error    string           `json:"error,omitempty"`
}

// Replay replays events for a project.
// This is the recovery mechanism.
func (s *Service) Replay(ctx context.Context, req *ReplayRequest) (*ReplayResponse, error) {
	start := time.Now()
	s.metrics.ReplayRequests++

	// Authenticate
	authCtx, err := s.authenticate(req.ClientID, req.ClientKey)
	if err != nil {
		s.metrics.AuthFailures++
		return &ReplayResponse{Success: false, Error: err.Error()}, ErrUnauthorized
	}

	// Verify project ID
	if req.ProjectID != "" && req.ProjectID != authCtx.ProjectID {
		return &ReplayResponse{Success: false, Error: "project ID mismatch"}, ErrProjectMismatch
	}

	projectID := authCtx.ProjectID

	s.logger.Info().
		Str("project_id", projectID).
		Uint64("from_sequence", req.FromSequence).
		Bool("verify_only", req.VerifyOnly).
		Msg("starting replay via API")

	var progress *replay.Progress

	if req.VerifyOnly {
		progress, err = s.replay.VerifyIntegrity(ctx, projectID)
	} else {
		// For Phase 1A, we just verify - state rebuilding comes in later phases
		progress, err = s.replay.ReplayFrom(ctx, projectID, req.FromSequence, nil)
	}

	if err != nil {
		s.logger.Error().Err(err).Str("project_id", projectID).Msg("replay failed")
		return &ReplayResponse{Progress: progress, Success: false, Error: err.Error()}, err
	}

	s.metrics.TotalLatencyNs += time.Since(start).Nanoseconds()

	s.logger.Info().
		Str("project_id", projectID).
		Uint64("events_processed", progress.ProcessedEvents).
		Dur("duration", time.Since(start)).
		Msg("replay completed via API")

	return &ReplayResponse{Progress: progress, Success: true}, nil
}

// CreateProjectRequest is the request for creating a project.
type CreateProjectRequest struct {
	ProjectID string `json:"project_id"`
}

// CreateProjectResponse is the response from creating a project.
type CreateProjectResponse struct {
	ProjectID string `json:"project_id"`
	ClientID  string `json:"client_id"`
	ClientKey string `json:"client_key"` // Only returned once!
	Success   bool   `json:"success"`
	Error     string `json:"error,omitempty"`
}

// CreateProject creates a new project with credentials.
// The client key is only returned once - store it securely!
func (s *Service) CreateProject(ctx context.Context, req *CreateProjectRequest) (*CreateProjectResponse, error) {
	if req.ProjectID == "" {
		return &CreateProjectResponse{Success: false, Error: "project_id required"}, ErrInvalidRequest
	}

	clientID, clientKey, err := s.auth.CreateProject(req.ProjectID)
	if err != nil {
		return &CreateProjectResponse{Success: false, Error: err.Error()}, err
	}

	s.logger.Info().
		Str("project_id", req.ProjectID).
		Str("client_id", clientID).
		Msg("project created via API")

	return &CreateProjectResponse{
		ProjectID: req.ProjectID,
		ClientID:  clientID,
		ClientKey: clientKey,
		Success:   true,
	}, nil
}

// GetMetrics returns current API metrics.
func (s *Service) GetMetrics() *Metrics {
	return s.metrics
}

// GetWALMetrics returns WAL metrics.
func (s *Service) GetWALMetrics() wal.Metrics {
	return s.wal.GetMetrics()
}

// Close shuts down the service gracefully.
func (s *Service) Close() error {
	s.logger.Info().Msg("shutting down API service")
	
	// Close document store
	if s.docStore != nil {
		if err := s.docStore.Close(); err != nil {
			s.logger.Error().Err(err).Msg("failed to close document store")
		}
	}
	
	// Close projection engine
	if s.projectionEngine != nil {
		if err := s.projectionEngine.Close(); err != nil {
			s.logger.Error().Err(err).Msg("failed to close projection engine")
		}
	}
	
	return s.wal.Close()
}

// authenticate validates credentials.
func (s *Service) authenticate(clientID, clientKey string) (*auth.AuthContext, error) {
	middleware := auth.NewMiddleware(s.auth)
	return middleware.Validate(clientID, clientKey)
}

// HealthCheck returns service health status.
type HealthStatus struct {
	Healthy   bool      `json:"healthy"`
	WALStatus string    `json:"wal_status"`
	Uptime    string    `json:"uptime"`
	Timestamp time.Time `json:"timestamp"`
}

var serviceStartTime = time.Now()

func (s *Service) HealthCheck() *HealthStatus {
	return &HealthStatus{
		Healthy:   true,
		WALStatus: "operational",
		Uptime:    time.Since(serviceStartTime).String(),
		Timestamp: time.Now().UTC(),
	}
}
