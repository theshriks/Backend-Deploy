// Package docstore provides document storage and retrieval for ShrikDB projections.
// This is a PROJECTION of the event log - documents can be deleted and rebuilt.
package docstore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// Document represents a projected document in ShrikDB.
type Document struct {
	ID         string                 `json:"id"`
	ProjectID  string                 `json:"project_id"`
	Collection string                 `json:"collection"`
	Content    map[string]interface{} `json:"content"`
	CreatedAt  time.Time             `json:"created_at"`
	UpdatedAt  time.Time             `json:"updated_at"`
	Version    uint64                `json:"version"`
	EventID    string                `json:"event_id"` // Last event that modified this doc
}

// Query represents a document query with filters and pagination.
type Query struct {
	ProjectID  string                 `json:"project_id"`
	Collection string                 `json:"collection,omitempty"`
	Filters    map[string]interface{} `json:"filters,omitempty"`
	Limit      int                    `json:"limit,omitempty"`
	Offset     int                    `json:"offset,omitempty"`
	SortBy     string                 `json:"sort_by,omitempty"`
	SortOrder  string                 `json:"sort_order,omitempty"` // "asc" or "desc"
}

// QueryResult contains query results with pagination metadata.
type QueryResult struct {
	Documents []*Document `json:"documents"`
	Total     int64       `json:"total"`
	Limit     int         `json:"limit"`
	Offset    int         `json:"offset"`
	HasMore   bool        `json:"has_more"`
}

// StoreStats provides statistics about the document store.
type StoreStats struct {
	ProjectID      string `json:"project_id"`
	DocumentCount  int64  `json:"document_count"`
	CollectionCount int   `json:"collection_count"`
	TotalSize      int64  `json:"total_size_bytes"`
	LastUpdated    time.Time `json:"last_updated"`
}

// Store defines the interface for document storage operations.
type Store interface {
	// Document CRUD operations
	CreateDocument(ctx context.Context, doc *Document) error
	UpdateDocument(ctx context.Context, docID string, updates map[string]interface{}) error
	DeleteDocument(ctx context.Context, docID string) error
	GetDocument(ctx context.Context, docID string) (*Document, error)
	
	// Query operations
	FindDocuments(ctx context.Context, query *Query) (*QueryResult, error)
	
	// Management operations
	Clear(ctx context.Context, projectID string) error
	GetStats(ctx context.Context, projectID string) (*StoreStats, error)
	
	// Lifecycle
	Close() error
}

// Common errors
var (
	ErrDocumentNotFound    = errors.New("document not found")
	ErrDocumentExists      = errors.New("document already exists")
	ErrInvalidDocument     = errors.New("invalid document")
	ErrInvalidQuery        = errors.New("invalid query")
	ErrProjectNotFound     = errors.New("project not found")
	ErrCollectionNotFound  = errors.New("collection not found")
)

// ValidateDocument checks if a document is valid.
func ValidateDocument(doc *Document) error {
	if doc == nil {
		return ErrInvalidDocument
	}
	if doc.ID == "" {
		return fmt.Errorf("document ID cannot be empty")
	}
	if doc.ProjectID == "" {
		return fmt.Errorf("project ID cannot be empty")
	}
	if doc.Collection == "" {
		return fmt.Errorf("collection cannot be empty")
	}
	if doc.Content == nil {
		return fmt.Errorf("content cannot be nil")
	}
	return nil
}

// ValidateQuery checks if a query is valid.
func ValidateQuery(query *Query) error {
	if query == nil {
		return ErrInvalidQuery
	}
	if query.ProjectID == "" {
		return fmt.Errorf("project ID cannot be empty")
	}
	if query.Limit < 0 {
		return fmt.Errorf("limit cannot be negative")
	}
	if query.Offset < 0 {
		return fmt.Errorf("offset cannot be negative")
	}
	if query.SortOrder != "" && query.SortOrder != "asc" && query.SortOrder != "desc" {
		return fmt.Errorf("sort order must be 'asc' or 'desc'")
	}
	return nil
}

// GenerateDocumentID creates a unique document ID.
func GenerateDocumentID() string {
	return fmt.Sprintf("doc_%d_%s", time.Now().UnixNano(), generateRandomString(8))
}

// generateRandomString creates a random string of specified length.
func generateRandomString(length int) string {
	const charset = "abcdefghijklmnopqrstuvwxyz0123456789"
	result := make([]byte, length)
	for i := range result {
		result[i] = charset[time.Now().UnixNano()%int64(len(charset))]
	}
	return string(result)
}

// MergeUpdates applies updates to document content.
func MergeUpdates(content map[string]interface{}, updates map[string]interface{}) map[string]interface{} {
	result := make(map[string]interface{})
	
	// Copy existing content
	for k, v := range content {
		result[k] = v
	}
	
	// Apply updates
	for k, v := range updates {
		result[k] = v
	}
	
	return result
}

// SerializeDocument converts a document to JSON bytes.
func SerializeDocument(doc *Document) ([]byte, error) {
	return json.Marshal(doc)
}

// DeserializeDocument converts JSON bytes to a document.
func DeserializeDocument(data []byte) (*Document, error) {
	var doc Document
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("failed to deserialize document: %w", err)
	}
	return &doc, nil
}