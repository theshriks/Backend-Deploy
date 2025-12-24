// Package query provides document query capabilities for ShrikDB projections.
// This package handles querying the document store, NOT the event log.
package query

import (
	"context"
	"fmt"

	"shrikdb/pkg/docstore"

	"github.com/rs/zerolog"
)

// Engine handles document queries against projections.
type Engine struct {
	store  docstore.Store
	logger zerolog.Logger
}

// QueryOptions provides options for document queries.
type QueryOptions struct {
	Filters   map[string]interface{} `json:"filters,omitempty"`
	Limit     int                    `json:"limit,omitempty"`
	Offset    int                    `json:"offset,omitempty"`
	SortBy    string                 `json:"sort_by,omitempty"`
	SortOrder string                 `json:"sort_order,omitempty"` // "asc" or "desc"
}

// New creates a new query engine.
func New(store docstore.Store, logger zerolog.Logger) *Engine {
	return &Engine{
		store:  store,
		logger: logger.With().Str("component", "query").Logger(),
	}
}

// FindByID finds a document by its ID.
func (e *Engine) FindByID(ctx context.Context, projectID, docID string) (*docstore.Document, error) {
	if projectID == "" {
		return nil, fmt.Errorf("project ID cannot be empty")
	}
	if docID == "" {
		return nil, fmt.Errorf("document ID cannot be empty")
	}
	
	e.logger.Debug().
		Str("project_id", projectID).
		Str("doc_id", docID).
		Msg("finding document by ID")
	
	doc, err := e.store.GetDocument(ctx, docID)
	if err != nil {
		if err == docstore.ErrDocumentNotFound {
			return nil, err
		}
		return nil, fmt.Errorf("failed to get document: %w", err)
	}
	
	// Verify document belongs to the project
	if doc.ProjectID != projectID {
		return nil, docstore.ErrDocumentNotFound
	}
	
	return doc, nil
}

// FindByFields finds documents matching field filters.
func (e *Engine) FindByFields(ctx context.Context, projectID string, filters map[string]interface{}) (*docstore.QueryResult, error) {
	if projectID == "" {
		return nil, fmt.Errorf("project ID cannot be empty")
	}
	
	e.logger.Debug().
		Str("project_id", projectID).
		Interface("filters", filters).
		Msg("finding documents by fields")
	
	query := &docstore.Query{
		ProjectID: projectID,
		Filters:   filters,
	}
	
	return e.store.FindDocuments(ctx, query)
}

// FindInCollection finds documents in a specific collection.
func (e *Engine) FindInCollection(ctx context.Context, projectID, collection string, opts *QueryOptions) (*docstore.QueryResult, error) {
	if projectID == "" {
		return nil, fmt.Errorf("project ID cannot be empty")
	}
	if collection == "" {
		return nil, fmt.Errorf("collection cannot be empty")
	}
	
	e.logger.Debug().
		Str("project_id", projectID).
		Str("collection", collection).
		Interface("options", opts).
		Msg("finding documents in collection")
	
	query := &docstore.Query{
		ProjectID:  projectID,
		Collection: collection,
	}
	
	if opts != nil {
		query.Filters = opts.Filters
		query.Limit = opts.Limit
		query.Offset = opts.Offset
		query.SortBy = opts.SortBy
		query.SortOrder = opts.SortOrder
	}
	
	return e.store.FindDocuments(ctx, query)
}

// CountDocuments counts documents matching the filters.
func (e *Engine) CountDocuments(ctx context.Context, projectID string, filters map[string]interface{}) (int64, error) {
	if projectID == "" {
		return 0, fmt.Errorf("project ID cannot be empty")
	}
	
	e.logger.Debug().
		Str("project_id", projectID).
		Interface("filters", filters).
		Msg("counting documents")
	
	query := &docstore.Query{
		ProjectID: projectID,
		Filters:   filters,
	}
	
	result, err := e.store.FindDocuments(ctx, query)
	if err != nil {
		return 0, fmt.Errorf("failed to find documents for count: %w", err)
	}
	
	return result.Total, nil
}

// ListCollections lists all collections in a project.
func (e *Engine) ListCollections(ctx context.Context, projectID string) ([]string, error) {
	if projectID == "" {
		return nil, fmt.Errorf("project ID cannot be empty")
	}
	
	e.logger.Debug().
		Str("project_id", projectID).
		Msg("listing collections")
	
	// Get all documents for the project
	query := &docstore.Query{
		ProjectID: projectID,
	}
	
	result, err := e.store.FindDocuments(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to find documents: %w", err)
	}
	
	// Extract unique collections
	collections := make(map[string]bool)
	for _, doc := range result.Documents {
		collections[doc.Collection] = true
	}
	
	// Convert to slice
	var collectionList []string
	for collection := range collections {
		collectionList = append(collectionList, collection)
	}
	
	return collectionList, nil
}

// FindWithPagination finds documents with pagination support.
func (e *Engine) FindWithPagination(ctx context.Context, projectID string, opts *QueryOptions) (*docstore.QueryResult, error) {
	if projectID == "" {
		return nil, fmt.Errorf("project ID cannot be empty")
	}
	
	e.logger.Debug().
		Str("project_id", projectID).
		Interface("options", opts).
		Msg("finding documents with pagination")
	
	query := &docstore.Query{
		ProjectID: projectID,
	}
	
	if opts != nil {
		query.Collection = ""
		query.Filters = opts.Filters
		query.Limit = opts.Limit
		query.Offset = opts.Offset
		query.SortBy = opts.SortBy
		query.SortOrder = opts.SortOrder
	}
	
	return e.store.FindDocuments(ctx, query)
}

// ValidateQueryOptions validates query options.
func ValidateQueryOptions(opts *QueryOptions) error {
	if opts == nil {
		return nil
	}
	
	if opts.Limit < 0 {
		return fmt.Errorf("limit cannot be negative")
	}
	if opts.Offset < 0 {
		return fmt.Errorf("offset cannot be negative")
	}
	if opts.SortOrder != "" && opts.SortOrder != "asc" && opts.SortOrder != "desc" {
		return fmt.Errorf("sort order must be 'asc' or 'desc'")
	}
	
	return nil
}