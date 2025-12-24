// Package api - Document API extensions for ShrikDB Phase 1B
package api

import (
	"context"
	"encoding/json"
	"fmt"

	"shrikdb/pkg/docstore"
	"shrikdb/pkg/projection"
	"shrikdb/pkg/query"
)

// Document API request/response types

// CreateDocumentRequest is the request for creating a document.
type CreateDocumentRequest struct {
	ClientID   string                 `json:"client_id"`
	ClientKey  string                 `json:"client_key"`
	ProjectID  string                 `json:"project_id"`
	Collection string                 `json:"collection"`
	Content    map[string]interface{} `json:"content"`
}

// CreateDocumentResponse is the response from creating a document.
type CreateDocumentResponse struct {
	DocumentID string `json:"document_id"`
	EventID    string `json:"event_id"`
	Success    bool   `json:"success"`
	Error      string `json:"error,omitempty"`
}

// UpdateDocumentRequest is the request for updating a document.
type UpdateDocumentRequest struct {
	ClientID   string                 `json:"client_id"`
	ClientKey  string                 `json:"client_key"`
	ProjectID  string                 `json:"project_id"`
	DocumentID string                 `json:"document_id"`
	Updates    map[string]interface{} `json:"updates"`
}

// UpdateDocumentResponse is the response from updating a document.
type UpdateDocumentResponse struct {
	DocumentID string `json:"document_id"`
	EventID    string `json:"event_id"`
	Version    uint64 `json:"version"`
	Success    bool   `json:"success"`
	Error      string `json:"error,omitempty"`
}

// DeleteDocumentRequest is the request for deleting a document.
type DeleteDocumentRequest struct {
	ClientID   string `json:"client_id"`
	ClientKey  string `json:"client_key"`
	ProjectID  string `json:"project_id"`
	DocumentID string `json:"document_id"`
}

// DeleteDocumentResponse is the response from deleting a document.
type DeleteDocumentResponse struct {
	DocumentID string `json:"document_id"`
	EventID    string `json:"event_id"`
	Success    bool   `json:"success"`
	Error      string `json:"error,omitempty"`
}

// GetDocumentRequest is the request for getting a document.
type GetDocumentRequest struct {
	ClientID   string `json:"client_id"`
	ClientKey  string `json:"client_key"`
	ProjectID  string `json:"project_id"`
	DocumentID string `json:"document_id"`
}

// GetDocumentResponse is the response from getting a document.
type GetDocumentResponse struct {
	Document *docstore.Document `json:"document,omitempty"`
	Success  bool               `json:"success"`
	Error    string             `json:"error,omitempty"`
}

// FindDocumentsRequest is the request for finding documents.
type FindDocumentsRequest struct {
	ClientID   string                 `json:"client_id"`
	ClientKey  string                 `json:"client_key"`
	ProjectID  string                 `json:"project_id"`
	Collection string                 `json:"collection,omitempty"`
	Filters    map[string]interface{} `json:"filters,omitempty"`
	Limit      int                    `json:"limit,omitempty"`
	Offset     int                    `json:"offset,omitempty"`
	SortBy     string                 `json:"sort_by,omitempty"`
	SortOrder  string                 `json:"sort_order,omitempty"`
}

// FindDocumentsResponse is the response from finding documents.
type FindDocumentsResponse struct {
	Result  *docstore.QueryResult `json:"result,omitempty"`
	Success bool                  `json:"success"`
	Error   string                `json:"error,omitempty"`
}

// ListCollectionsRequest is the request for listing collections.
type ListCollectionsRequest struct {
	ClientID  string `json:"client_id"`
	ClientKey string `json:"client_key"`
	ProjectID string `json:"project_id"`
}

// ListCollectionsResponse is the response from listing collections.
type ListCollectionsResponse struct {
	Collections []string `json:"collections"`
	Success     bool     `json:"success"`
	Error       string   `json:"error,omitempty"`
}

// RebuildProjectionRequest is the request for rebuilding projections.
type RebuildProjectionRequest struct {
	ClientID  string `json:"client_id"`
	ClientKey string `json:"client_key"`
	ProjectID string `json:"project_id"`
}

// RebuildProjectionResponse is the response from rebuilding projections.
type RebuildProjectionResponse struct {
	EventsProcessed uint64 `json:"events_processed"`
	Success         bool   `json:"success"`
	Error           string `json:"error,omitempty"`
}

// ProjectionStatusRequest is the request for getting projection status.
type ProjectionStatusRequest struct {
	ClientID  string `json:"client_id"`
	ClientKey string `json:"client_key"`
	ProjectID string `json:"project_id"`
}

// ProjectionStatusResponse is the response from getting projection status.
type ProjectionStatusResponse struct {
	Metrics *projection.Metrics `json:"metrics"`
	Stats   *docstore.StoreStats `json:"stats"`
	Success bool                `json:"success"`
	Error   string              `json:"error,omitempty"`
}

// Document API methods

// CreateDocument creates a new document by first creating an event, then updating the projection.
func (s *Service) CreateDocument(ctx context.Context, req *CreateDocumentRequest) (*CreateDocumentResponse, error) {
	// Authenticate
	authCtx, err := s.authenticate(req.ClientID, req.ClientKey)
	if err != nil {
		return &CreateDocumentResponse{Success: false, Error: err.Error()}, ErrUnauthorized
	}

	// Verify project ID
	if req.ProjectID != "" && req.ProjectID != authCtx.ProjectID {
		return &CreateDocumentResponse{Success: false, Error: "project ID mismatch"}, ErrProjectMismatch
	}

	projectID := authCtx.ProjectID

	// Validate request
	if req.Collection == "" {
		return &CreateDocumentResponse{Success: false, Error: "collection required"}, ErrInvalidRequest
	}
	if req.Content == nil || len(req.Content) == 0 {
		return &CreateDocumentResponse{Success: false, Error: "content required"}, ErrInvalidRequest
	}

	// Generate document ID
	documentID := docstore.GenerateDocumentID()

	// Create document.created event payload
	payload := projection.DocumentCreatedPayload{
		DocumentID: documentID,
		Collection: req.Collection,
		Content:    req.Content,
	}

	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return &CreateDocumentResponse{Success: false, Error: "failed to marshal payload"}, fmt.Errorf("failed to marshal payload: %w", err)
	}

	// Step 1: Append event to WAL FIRST
	evt, err := s.wal.Append(projectID, "document.created", payloadBytes, nil)
	if err != nil {
		s.logger.Error().Err(err).Str("project_id", projectID).Msg("failed to append document.created event")
		return &CreateDocumentResponse{Success: false, Error: err.Error()}, err
	}

	// Step 2: Update projection (if this fails, event still persists)
	if s.projectionEngine != nil {
		err = s.projectionEngine.ProcessEvent(ctx, evt)
		if err != nil {
			s.logger.Error().Err(err).Str("event_id", evt.EventID).Msg("failed to update projection, but event persists")
			// Don't return error - event is safely stored
		}
	}

	s.logger.Info().
		Str("document_id", documentID).
		Str("collection", req.Collection).
		Str("event_id", evt.EventID).
		Msg("document created via API")

	return &CreateDocumentResponse{
		DocumentID: documentID,
		EventID:    evt.EventID,
		Success:    true,
	}, nil
}

// UpdateDocument updates a document by first creating an event, then updating the projection.
func (s *Service) UpdateDocument(ctx context.Context, req *UpdateDocumentRequest) (*UpdateDocumentResponse, error) {
	// Authenticate
	authCtx, err := s.authenticate(req.ClientID, req.ClientKey)
	if err != nil {
		return &UpdateDocumentResponse{Success: false, Error: err.Error()}, ErrUnauthorized
	}

	// Verify project ID
	if req.ProjectID != "" && req.ProjectID != authCtx.ProjectID {
		return &UpdateDocumentResponse{Success: false, Error: "project ID mismatch"}, ErrProjectMismatch
	}

	projectID := authCtx.ProjectID

	// Validate request
	if req.DocumentID == "" {
		return &UpdateDocumentResponse{Success: false, Error: "document_id required"}, ErrInvalidRequest
	}
	if req.Updates == nil || len(req.Updates) == 0 {
		return &UpdateDocumentResponse{Success: false, Error: "updates required"}, ErrInvalidRequest
	}

	// Create document.updated event payload
	payload := projection.DocumentUpdatedPayload{
		DocumentID: req.DocumentID,
		Updates:    req.Updates,
	}

	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return &UpdateDocumentResponse{Success: false, Error: "failed to marshal payload"}, fmt.Errorf("failed to marshal payload: %w", err)
	}

	// Step 1: Append event to WAL FIRST
	evt, err := s.wal.Append(projectID, "document.updated", payloadBytes, nil)
	if err != nil {
		s.logger.Error().Err(err).Str("project_id", projectID).Msg("failed to append document.updated event")
		return &UpdateDocumentResponse{Success: false, Error: err.Error()}, err
	}

	// Step 2: Update projection (if this fails, event still persists)
	var version uint64 = 0
	if s.projectionEngine != nil {
		err = s.projectionEngine.ProcessEvent(ctx, evt)
		if err != nil {
			s.logger.Error().Err(err).Str("event_id", evt.EventID).Msg("failed to update projection, but event persists")
			// Don't return error - event is safely stored
		} else if s.queryEngine != nil {
			// Get updated document to return version
			if doc, err := s.queryEngine.FindByID(ctx, projectID, req.DocumentID); err == nil {
				version = doc.Version
			}
		}
	}

	s.logger.Info().
		Str("document_id", req.DocumentID).
		Str("event_id", evt.EventID).
		Msg("document updated via API")

	return &UpdateDocumentResponse{
		DocumentID: req.DocumentID,
		EventID:    evt.EventID,
		Version:    version,
		Success:    true,
	}, nil
}

// DeleteDocument deletes a document by first creating an event, then updating the projection.
func (s *Service) DeleteDocument(ctx context.Context, req *DeleteDocumentRequest) (*DeleteDocumentResponse, error) {
	// Authenticate
	authCtx, err := s.authenticate(req.ClientID, req.ClientKey)
	if err != nil {
		return &DeleteDocumentResponse{Success: false, Error: err.Error()}, ErrUnauthorized
	}

	// Verify project ID
	if req.ProjectID != "" && req.ProjectID != authCtx.ProjectID {
		return &DeleteDocumentResponse{Success: false, Error: "project ID mismatch"}, ErrProjectMismatch
	}

	projectID := authCtx.ProjectID

	// Validate request
	if req.DocumentID == "" {
		return &DeleteDocumentResponse{Success: false, Error: "document_id required"}, ErrInvalidRequest
	}

	// Get document collection (needed for event payload)
	var collection string
	if s.queryEngine != nil {
		if doc, err := s.queryEngine.FindByID(ctx, projectID, req.DocumentID); err == nil {
			collection = doc.Collection
		}
	}

	// Create document.deleted event payload
	payload := projection.DocumentDeletedPayload{
		DocumentID: req.DocumentID,
		Collection: collection,
	}

	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return &DeleteDocumentResponse{Success: false, Error: "failed to marshal payload"}, fmt.Errorf("failed to marshal payload: %w", err)
	}

	// Step 1: Append event to WAL FIRST
	evt, err := s.wal.Append(projectID, "document.deleted", payloadBytes, nil)
	if err != nil {
		s.logger.Error().Err(err).Str("project_id", projectID).Msg("failed to append document.deleted event")
		return &DeleteDocumentResponse{Success: false, Error: err.Error()}, err
	}

	// Step 2: Update projection (if this fails, event still persists)
	if s.projectionEngine != nil {
		err = s.projectionEngine.ProcessEvent(ctx, evt)
		if err != nil {
			s.logger.Error().Err(err).Str("event_id", evt.EventID).Msg("failed to update projection, but event persists")
			// Don't return error - event is safely stored
		}
	}

	s.logger.Info().
		Str("document_id", req.DocumentID).
		Str("event_id", evt.EventID).
		Msg("document deleted via API")

	return &DeleteDocumentResponse{
		DocumentID: req.DocumentID,
		EventID:    evt.EventID,
		Success:    true,
	}, nil
}

// GetDocument retrieves a document from the projection.
func (s *Service) GetDocument(ctx context.Context, req *GetDocumentRequest) (*GetDocumentResponse, error) {
	// Authenticate
	authCtx, err := s.authenticate(req.ClientID, req.ClientKey)
	if err != nil {
		return &GetDocumentResponse{Success: false, Error: err.Error()}, ErrUnauthorized
	}

	// Verify project ID
	if req.ProjectID != "" && req.ProjectID != authCtx.ProjectID {
		return &GetDocumentResponse{Success: false, Error: "project ID mismatch"}, ErrProjectMismatch
	}

	projectID := authCtx.ProjectID

	// Validate request
	if req.DocumentID == "" {
		return &GetDocumentResponse{Success: false, Error: "document_id required"}, ErrInvalidRequest
	}

	if s.queryEngine == nil {
		return &GetDocumentResponse{Success: false, Error: "query engine not available"}, fmt.Errorf("query engine not initialized")
	}

	// Query projection
	doc, err := s.queryEngine.FindByID(ctx, projectID, req.DocumentID)
	if err != nil {
		if err == docstore.ErrDocumentNotFound {
			return &GetDocumentResponse{Success: false, Error: "document not found"}, err
		}
		return &GetDocumentResponse{Success: false, Error: err.Error()}, err
	}

	return &GetDocumentResponse{
		Document: doc,
		Success:  true,
	}, nil
}

// FindDocuments finds documents in the projection.
func (s *Service) FindDocuments(ctx context.Context, req *FindDocumentsRequest) (*FindDocumentsResponse, error) {
	// Authenticate
	authCtx, err := s.authenticate(req.ClientID, req.ClientKey)
	if err != nil {
		return &FindDocumentsResponse{Success: false, Error: err.Error()}, ErrUnauthorized
	}

	// Verify project ID
	if req.ProjectID != "" && req.ProjectID != authCtx.ProjectID {
		return &FindDocumentsResponse{Success: false, Error: "project ID mismatch"}, ErrProjectMismatch
	}

	projectID := authCtx.ProjectID

	if s.queryEngine == nil {
		return &FindDocumentsResponse{Success: false, Error: "query engine not available"}, fmt.Errorf("query engine not initialized")
	}

	// Build query options
	opts := &query.QueryOptions{
		Filters:   req.Filters,
		Limit:     req.Limit,
		Offset:    req.Offset,
		SortBy:    req.SortBy,
		SortOrder: req.SortOrder,
	}

	// Validate options
	if err := query.ValidateQueryOptions(opts); err != nil {
		return &FindDocumentsResponse{Success: false, Error: err.Error()}, ErrInvalidRequest
	}

	var result *docstore.QueryResult

	if req.Collection != "" {
		// Query specific collection
		result, err = s.queryEngine.FindInCollection(ctx, projectID, req.Collection, opts)
	} else {
		// Query all collections
		result, err = s.queryEngine.FindWithPagination(ctx, projectID, opts)
	}

	if err != nil {
		return &FindDocumentsResponse{Success: false, Error: err.Error()}, err
	}

	return &FindDocumentsResponse{
		Result:  result,
		Success: true,
	}, nil
}

// ListCollections lists all collections in a project.
func (s *Service) ListCollections(ctx context.Context, req *ListCollectionsRequest) (*ListCollectionsResponse, error) {
	// Authenticate
	authCtx, err := s.authenticate(req.ClientID, req.ClientKey)
	if err != nil {
		return &ListCollectionsResponse{Success: false, Error: err.Error()}, ErrUnauthorized
	}

	// Verify project ID
	if req.ProjectID != "" && req.ProjectID != authCtx.ProjectID {
		return &ListCollectionsResponse{Success: false, Error: "project ID mismatch"}, ErrProjectMismatch
	}

	projectID := authCtx.ProjectID

	if s.queryEngine == nil {
		return &ListCollectionsResponse{Success: false, Error: "query engine not available"}, fmt.Errorf("query engine not initialized")
	}

	collections, err := s.queryEngine.ListCollections(ctx, projectID)
	if err != nil {
		return &ListCollectionsResponse{Success: false, Error: err.Error()}, err
	}

	return &ListCollectionsResponse{
		Collections: collections,
		Success:     true,
	}, nil
}

// RebuildProjection rebuilds document projections from events.
func (s *Service) RebuildProjection(ctx context.Context, req *RebuildProjectionRequest) (*RebuildProjectionResponse, error) {
	// Authenticate
	authCtx, err := s.authenticate(req.ClientID, req.ClientKey)
	if err != nil {
		return &RebuildProjectionResponse{Success: false, Error: err.Error()}, ErrUnauthorized
	}

	// Verify project ID
	if req.ProjectID != "" && req.ProjectID != authCtx.ProjectID {
		return &RebuildProjectionResponse{Success: false, Error: "project ID mismatch"}, ErrProjectMismatch
	}

	projectID := authCtx.ProjectID

	if s.projectionEngine == nil {
		return &RebuildProjectionResponse{Success: false, Error: "projection engine not available"}, fmt.Errorf("projection engine not initialized")
	}

	// Read all events for the project
	events, err := s.wal.ReadEvents(projectID, 0)
	if err != nil {
		return &RebuildProjectionResponse{Success: false, Error: err.Error()}, err
	}

	// Rebuild projections
	err = s.projectionEngine.RebuildFromEvents(ctx, projectID, events)
	if err != nil {
		return &RebuildProjectionResponse{Success: false, Error: err.Error()}, err
	}

	s.logger.Info().
		Str("project_id", projectID).
		Int("events_processed", len(events)).
		Msg("projection rebuilt via API")

	return &RebuildProjectionResponse{
		EventsProcessed: uint64(len(events)),
		Success:         true,
	}, nil
}

// GetProjectionStatus returns the current projection status.
func (s *Service) GetProjectionStatus(ctx context.Context, req *ProjectionStatusRequest) (*ProjectionStatusResponse, error) {
	// Authenticate
	authCtx, err := s.authenticate(req.ClientID, req.ClientKey)
	if err != nil {
		return &ProjectionStatusResponse{Success: false, Error: err.Error()}, ErrUnauthorized
	}

	// Verify project ID
	if req.ProjectID != "" && req.ProjectID != authCtx.ProjectID {
		return &ProjectionStatusResponse{Success: false, Error: "project ID mismatch"}, ErrProjectMismatch
	}

	projectID := authCtx.ProjectID

	var metrics *projection.Metrics
	var stats *docstore.StoreStats

	if s.projectionEngine != nil {
		metrics = s.projectionEngine.GetMetrics()
	}

	if s.docStore != nil {
		stats, err = s.docStore.GetStats(ctx, projectID)
		if err != nil {
			s.logger.Warn().Err(err).Msg("failed to get store stats")
		}
	}

	return &ProjectionStatusResponse{
		Metrics: metrics,
		Stats:   stats,
		Success: true,
	}, nil
}