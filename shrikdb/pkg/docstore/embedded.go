// Package docstore - embedded implementation using JSON files
package docstore

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"
)

// EmbeddedStore implements Store using JSON files for document storage.
type EmbeddedStore struct {
	dataDir string
	logger  zerolog.Logger
	mu      sync.RWMutex
	
	// In-memory cache for fast queries
	documents map[string]*Document // docID -> Document
	projects  map[string]map[string]*Document // projectID -> docID -> Document
}

// NewEmbeddedStore creates a new embedded document store.
func NewEmbeddedStore(dataDir string, logger zerolog.Logger) (*EmbeddedStore, error) {
	store := &EmbeddedStore{
		dataDir:   dataDir,
		logger:    logger.With().Str("component", "docstore").Logger(),
		documents: make(map[string]*Document),
		projects:  make(map[string]map[string]*Document),
	}
	
	// Create data directory if it doesn't exist
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create data directory: %w", err)
	}
	
	// Load existing documents
	if err := store.loadDocuments(); err != nil {
		return nil, fmt.Errorf("failed to load documents: %w", err)
	}
	
	return store, nil
}

// CreateDocument creates a new document.
func (s *EmbeddedStore) CreateDocument(ctx context.Context, doc *Document) error {
	if err := ValidateDocument(doc); err != nil {
		return err
	}
	
	s.mu.Lock()
	defer s.mu.Unlock()
	
	// Check if document already exists
	if _, exists := s.documents[doc.ID]; exists {
		return ErrDocumentExists
	}
	
	// Set timestamps
	now := time.Now().UTC()
	doc.CreatedAt = now
	doc.UpdatedAt = now
	doc.Version = 1
	
	// Store in memory
	s.documents[doc.ID] = doc
	
	// Ensure project map exists
	if s.projects[doc.ProjectID] == nil {
		s.projects[doc.ProjectID] = make(map[string]*Document)
	}
	s.projects[doc.ProjectID][doc.ID] = doc
	
	// Persist to disk
	if err := s.saveDocument(doc); err != nil {
		// Rollback memory changes
		delete(s.documents, doc.ID)
		delete(s.projects[doc.ProjectID], doc.ID)
		return fmt.Errorf("failed to save document: %w", err)
	}
	
	s.logger.Debug().
		Str("doc_id", doc.ID).
		Str("project_id", doc.ProjectID).
		Str("collection", doc.Collection).
		Msg("document created")
	
	return nil
}

// UpdateDocument updates an existing document.
func (s *EmbeddedStore) UpdateDocument(ctx context.Context, docID string, updates map[string]interface{}) error {
	if docID == "" {
		return fmt.Errorf("document ID cannot be empty")
	}
	if len(updates) == 0 {
		return fmt.Errorf("updates cannot be empty")
	}
	
	s.mu.Lock()
	defer s.mu.Unlock()
	
	// Get existing document
	doc, exists := s.documents[docID]
	if !exists {
		return ErrDocumentNotFound
	}
	
	// Create updated document
	updatedDoc := &Document{
		ID:         doc.ID,
		ProjectID:  doc.ProjectID,
		Collection: doc.Collection,
		Content:    MergeUpdates(doc.Content, updates),
		CreatedAt:  doc.CreatedAt,
		UpdatedAt:  time.Now().UTC(),
		Version:    doc.Version + 1,
		EventID:    doc.EventID,
	}
	
	// Update in memory
	s.documents[docID] = updatedDoc
	s.projects[doc.ProjectID][docID] = updatedDoc
	
	// Persist to disk
	if err := s.saveDocument(updatedDoc); err != nil {
		// Rollback memory changes
		s.documents[docID] = doc
		s.projects[doc.ProjectID][docID] = doc
		return fmt.Errorf("failed to save updated document: %w", err)
	}
	
	s.logger.Debug().
		Str("doc_id", docID).
		Uint64("version", updatedDoc.Version).
		Msg("document updated")
	
	return nil
}

// DeleteDocument deletes a document.
func (s *EmbeddedStore) DeleteDocument(ctx context.Context, docID string) error {
	if docID == "" {
		return fmt.Errorf("document ID cannot be empty")
	}
	
	s.mu.Lock()
	defer s.mu.Unlock()
	
	// Get existing document
	doc, exists := s.documents[docID]
	if !exists {
		return ErrDocumentNotFound
	}
	
	// Remove from memory
	delete(s.documents, docID)
	delete(s.projects[doc.ProjectID], docID)
	
	// Remove from disk
	if err := s.deleteDocumentFile(docID); err != nil {
		// Rollback memory changes
		s.documents[docID] = doc
		s.projects[doc.ProjectID][docID] = doc
		return fmt.Errorf("failed to delete document file: %w", err)
	}
	
	s.logger.Debug().
		Str("doc_id", docID).
		Str("project_id", doc.ProjectID).
		Msg("document deleted")
	
	return nil
}

// GetDocument retrieves a document by ID.
func (s *EmbeddedStore) GetDocument(ctx context.Context, docID string) (*Document, error) {
	if docID == "" {
		return nil, fmt.Errorf("document ID cannot be empty")
	}
	
	s.mu.RLock()
	defer s.mu.RUnlock()
	
	doc, exists := s.documents[docID]
	if !exists {
		return nil, ErrDocumentNotFound
	}
	
	// Return a copy to prevent external modification
	return s.copyDocument(doc), nil
}

// FindDocuments finds documents matching the query.
func (s *EmbeddedStore) FindDocuments(ctx context.Context, query *Query) (*QueryResult, error) {
	if err := ValidateQuery(query); err != nil {
		return nil, err
	}
	
	s.mu.RLock()
	defer s.mu.RUnlock()
	
	// Get project documents
	projectDocs, exists := s.projects[query.ProjectID]
	if !exists {
		return &QueryResult{
			Documents: []*Document{},
			Total:     0,
			Limit:     query.Limit,
			Offset:    query.Offset,
			HasMore:   false,
		}, nil
	}
	
	// Filter documents
	var matches []*Document
	for _, doc := range projectDocs {
		if s.matchesQuery(doc, query) {
			matches = append(matches, s.copyDocument(doc))
		}
	}
	
	// Sort documents
	if query.SortBy != "" {
		s.sortDocuments(matches, query.SortBy, query.SortOrder)
	}
	
	// Apply pagination
	total := int64(len(matches))
	start := query.Offset
	end := start + query.Limit
	
	if start >= len(matches) {
		return &QueryResult{
			Documents: []*Document{},
			Total:     total,
			Limit:     query.Limit,
			Offset:    query.Offset,
			HasMore:   false,
		}, nil
	}
	
	if query.Limit > 0 && end > len(matches) {
		end = len(matches)
	} else if query.Limit == 0 {
		end = len(matches)
	}
	
	result := matches[start:end]
	hasMore := end < len(matches)
	
	return &QueryResult{
		Documents: result,
		Total:     total,
		Limit:     query.Limit,
		Offset:    query.Offset,
		HasMore:   hasMore,
	}, nil
}

// Clear removes all documents for a project.
func (s *EmbeddedStore) Clear(ctx context.Context, projectID string) error {
	if projectID == "" {
		return fmt.Errorf("project ID cannot be empty")
	}
	
	s.mu.Lock()
	defer s.mu.Unlock()
	
	// Get project documents
	projectDocs, exists := s.projects[projectID]
	if !exists {
		return nil // Nothing to clear
	}
	
	// Remove from memory
	for docID := range projectDocs {
		delete(s.documents, docID)
	}
	delete(s.projects, projectID)
	
	// Remove project directory
	projectDir := filepath.Join(s.dataDir, "projects", projectID)
	if err := os.RemoveAll(projectDir); err != nil {
		return fmt.Errorf("failed to remove project directory: %w", err)
	}
	
	s.logger.Info().
		Str("project_id", projectID).
		Msg("project documents cleared")
	
	return nil
}

// GetStats returns statistics for a project.
func (s *EmbeddedStore) GetStats(ctx context.Context, projectID string) (*StoreStats, error) {
	if projectID == "" {
		return nil, fmt.Errorf("project ID cannot be empty")
	}
	
	s.mu.RLock()
	defer s.mu.RUnlock()
	
	projectDocs, exists := s.projects[projectID]
	if !exists {
		return &StoreStats{
			ProjectID:       projectID,
			DocumentCount:   0,
			CollectionCount: 0,
			TotalSize:       0,
			LastUpdated:     time.Time{},
		}, nil
	}
	
	collections := make(map[string]bool)
	var totalSize int64
	var lastUpdated time.Time
	
	for _, doc := range projectDocs {
		collections[doc.Collection] = true
		
		// Estimate size
		if data, err := json.Marshal(doc); err == nil {
			totalSize += int64(len(data))
		}
		
		// Track latest update
		if doc.UpdatedAt.After(lastUpdated) {
			lastUpdated = doc.UpdatedAt
		}
	}
	
	return &StoreStats{
		ProjectID:       projectID,
		DocumentCount:   int64(len(projectDocs)),
		CollectionCount: len(collections),
		TotalSize:       totalSize,
		LastUpdated:     lastUpdated,
	}, nil
}

// Close closes the store.
func (s *EmbeddedStore) Close() error {
	s.logger.Info().Msg("closing embedded document store")
	return nil
}

// Helper methods

func (s *EmbeddedStore) loadDocuments() error {
	projectsDir := filepath.Join(s.dataDir, "projects")
	
	// Check if projects directory exists
	if _, err := os.Stat(projectsDir); os.IsNotExist(err) {
		return nil // No documents to load
	}
	
	// Walk through project directories
	return filepath.Walk(projectsDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		
		if !info.IsDir() && strings.HasSuffix(path, ".json") {
			data, err := os.ReadFile(path)
			if err != nil {
				s.logger.Warn().Err(err).Str("file", path).Msg("failed to read document file")
				return nil // Continue with other files
			}
			
			doc, err := DeserializeDocument(data)
			if err != nil {
				s.logger.Warn().Err(err).Str("file", path).Msg("failed to deserialize document")
				return nil // Continue with other files
			}
			
			// Add to memory
			s.documents[doc.ID] = doc
			if s.projects[doc.ProjectID] == nil {
				s.projects[doc.ProjectID] = make(map[string]*Document)
			}
			s.projects[doc.ProjectID][doc.ID] = doc
		}
		
		return nil
	})
}

func (s *EmbeddedStore) saveDocument(doc *Document) error {
	projectDir := filepath.Join(s.dataDir, "projects", doc.ProjectID)
	if err := os.MkdirAll(projectDir, 0755); err != nil {
		return err
	}
	
	filePath := filepath.Join(projectDir, doc.ID+".json")
	data, err := SerializeDocument(doc)
	if err != nil {
		return err
	}
	
	return os.WriteFile(filePath, data, 0644)
}

func (s *EmbeddedStore) deleteDocumentFile(docID string) error {
	// Find the document file across all projects
	projectsDir := filepath.Join(s.dataDir, "projects")
	
	return filepath.Walk(projectsDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		
		if !info.IsDir() && strings.HasSuffix(path, docID+".json") {
			return os.Remove(path)
		}
		
		return nil
	})
}

func (s *EmbeddedStore) copyDocument(doc *Document) *Document {
	content := make(map[string]interface{})
	for k, v := range doc.Content {
		content[k] = v
	}
	
	return &Document{
		ID:         doc.ID,
		ProjectID:  doc.ProjectID,
		Collection: doc.Collection,
		Content:    content,
		CreatedAt:  doc.CreatedAt,
		UpdatedAt:  doc.UpdatedAt,
		Version:    doc.Version,
		EventID:    doc.EventID,
	}
}

func (s *EmbeddedStore) matchesQuery(doc *Document, query *Query) bool {
	// Check collection filter
	if query.Collection != "" && doc.Collection != query.Collection {
		return false
	}
	
	// Check field filters
	for field, expectedValue := range query.Filters {
		if field == "id" {
			if doc.ID != expectedValue {
				return false
			}
			continue
		}
		
		actualValue, exists := doc.Content[field]
		if !exists {
			return false
		}
		
		// Handle type conversions for numeric comparisons
		if !valuesEqual(actualValue, expectedValue) {
			return false
		}
	}
	
	return true
}

func (s *EmbeddedStore) sortDocuments(docs []*Document, sortBy, sortOrder string) {
	sort.Slice(docs, func(i, j int) bool {
		var val1, val2 interface{}
		
		switch sortBy {
		case "id":
			val1, val2 = docs[i].ID, docs[j].ID
		case "created_at":
			val1, val2 = docs[i].CreatedAt, docs[j].CreatedAt
		case "updated_at":
			val1, val2 = docs[i].UpdatedAt, docs[j].UpdatedAt
		case "version":
			val1, val2 = docs[i].Version, docs[j].Version
		default:
			// Sort by content field
			val1 = docs[i].Content[sortBy]
			val2 = docs[j].Content[sortBy]
		}
		
		// Compare values
		result := compareValues(val1, val2)
		
		if sortOrder == "desc" {
			return result > 0
		}
		return result < 0
	})
}

func compareValues(a, b interface{}) int {
	// Handle nil values
	if a == nil && b == nil {
		return 0
	}
	if a == nil {
		return -1
	}
	if b == nil {
		return 1
	}
	
	// Convert to comparable types
	aVal := convertToComparable(a)
	bVal := convertToComparable(b)
	
	// Compare based on type
	switch av := aVal.(type) {
	case string:
		if bv, ok := bVal.(string); ok {
			if av < bv {
				return -1
			} else if av > bv {
				return 1
			}
			return 0
		}
	case float64:
		if bv, ok := bVal.(float64); ok {
			if av < bv {
				return -1
			} else if av > bv {
				return 1
			}
			return 0
		}
	case bool:
		if bv, ok := bVal.(bool); ok {
			if av == bv {
				return 0
			} else if av {
				return 1
			}
			return -1
		}
	case time.Time:
		if bv, ok := bVal.(time.Time); ok {
			if av.Before(bv) {
				return -1
			} else if av.After(bv) {
				return 1
			}
			return 0
		}
	}
	
	// Fallback to string comparison
	return strings.Compare(fmt.Sprintf("%v", a), fmt.Sprintf("%v", b))
}

// valuesEqual compares two values with type conversion for numbers
func valuesEqual(a, b interface{}) bool {
	if a == b {
		return true
	}
	
	// Handle numeric comparisons with type conversion
	aNum, aIsNum := convertToNumber(a)
	bNum, bIsNum := convertToNumber(b)
	
	if aIsNum && bIsNum {
		return aNum == bNum
	}
	
	return false
}

// convertToNumber converts various numeric types to float64
func convertToNumber(v interface{}) (float64, bool) {
	switch val := v.(type) {
	case int:
		return float64(val), true
	case int8:
		return float64(val), true
	case int16:
		return float64(val), true
	case int32:
		return float64(val), true
	case int64:
		return float64(val), true
	case uint:
		return float64(val), true
	case uint8:
		return float64(val), true
	case uint16:
		return float64(val), true
	case uint32:
		return float64(val), true
	case uint64:
		return float64(val), true
	case float32:
		return float64(val), true
	case float64:
		return val, true
	default:
		return 0, false
	}
}

func convertToComparable(v interface{}) interface{} {
	// Convert numbers to float64 for consistent comparison
	if num, isNum := convertToNumber(v); isNum {
		return num
	}
	
	// Convert time.Time to Unix timestamp
	if t, ok := v.(time.Time); ok {
		return t.Unix()
	}
	
	// Return as-is for strings, bools, etc.
	return v
}