package query

import (
	"context"
	"fmt"
	"os"
	"testing"
	"testing/quick"

	"shrikdb/pkg/docstore"

	"github.com/rs/zerolog"
)

func TestQueryEngine_FindByID(t *testing.T) {
	// Create temporary directory
	tempDir := t.TempDir()
	
	// Create store and engine
	logger := zerolog.New(os.Stdout)
	store, err := docstore.NewEmbeddedStore(tempDir, logger)
	if err != nil {
		t.Fatalf("Failed to create store: %v", err)
	}
	defer store.Close()
	
	engine := New(store, logger)
	ctx := context.Background()
	
	// Create test document
	doc := &docstore.Document{
		ID:         "doc_123",
		ProjectID:  "project1",
		Collection: "users",
		Content: map[string]interface{}{
			"name":  "John Doe",
			"email": "john@example.com",
		},
	}
	
	err = store.CreateDocument(ctx, doc)
	if err != nil {
		t.Fatalf("Failed to create document: %v", err)
	}
	
	// Test finding by ID
	found, err := engine.FindByID(ctx, "project1", "doc_123")
	if err != nil {
		t.Fatalf("Failed to find document by ID: %v", err)
	}
	
	if found.ID != "doc_123" {
		t.Errorf("ID mismatch: got %v, want doc_123", found.ID)
	}
	if found.Content["name"] != "John Doe" {
		t.Errorf("Name mismatch: got %v, want John Doe", found.Content["name"])
	}
	
	// Test finding non-existent document
	_, err = engine.FindByID(ctx, "project1", "nonexistent")
	if err != docstore.ErrDocumentNotFound {
		t.Errorf("Expected ErrDocumentNotFound, got %v", err)
	}
	
	// Test project isolation
	_, err = engine.FindByID(ctx, "project2", "doc_123")
	if err != docstore.ErrDocumentNotFound {
		t.Errorf("Expected ErrDocumentNotFound for different project, got %v", err)
	}
}

func TestQueryEngine_FindByFields(t *testing.T) {
	// Create temporary directory
	tempDir := t.TempDir()
	
	// Create store and engine
	logger := zerolog.New(os.Stdout)
	store, err := docstore.NewEmbeddedStore(tempDir, logger)
	if err != nil {
		t.Fatalf("Failed to create store: %v", err)
	}
	defer store.Close()
	
	engine := New(store, logger)
	ctx := context.Background()
	
	// Create test documents
	docs := []*docstore.Document{
		{
			ID:         "doc_1",
			ProjectID:  "project1",
			Collection: "users",
			Content:    map[string]interface{}{"name": "Alice", "age": 25, "city": "NYC"},
		},
		{
			ID:         "doc_2",
			ProjectID:  "project1",
			Collection: "users",
			Content:    map[string]interface{}{"name": "Bob", "age": 30, "city": "SF"},
		},
		{
			ID:         "doc_3",
			ProjectID:  "project1",
			Collection: "users",
			Content:    map[string]interface{}{"name": "Charlie", "age": 25, "city": "LA"},
		},
	}
	
	for _, doc := range docs {
		err = store.CreateDocument(ctx, doc)
		if err != nil {
			t.Fatalf("Failed to create document %s: %v", doc.ID, err)
		}
	}
	
	// Test finding by single field
	result, err := engine.FindByFields(ctx, "project1", map[string]interface{}{"age": 25})
	if err != nil {
		t.Fatalf("Failed to find by fields: %v", err)
	}
	
	if len(result.Documents) != 2 {
		t.Errorf("Expected 2 documents with age=25, got %d", len(result.Documents))
	}
	
	// Test finding by multiple fields
	result, err = engine.FindByFields(ctx, "project1", map[string]interface{}{
		"age":  25,
		"city": "NYC",
	})
	if err != nil {
		t.Fatalf("Failed to find by multiple fields: %v", err)
	}
	
	if len(result.Documents) != 1 {
		t.Errorf("Expected 1 document with age=25 and city=NYC, got %d", len(result.Documents))
	}
	if result.Documents[0].Content["name"] != "Alice" {
		t.Errorf("Expected Alice, got %v", result.Documents[0].Content["name"])
	}
}

func TestQueryEngine_FindInCollection(t *testing.T) {
	// Create temporary directory
	tempDir := t.TempDir()
	
	// Create store and engine
	logger := zerolog.New(os.Stdout)
	store, err := docstore.NewEmbeddedStore(tempDir, logger)
	if err != nil {
		t.Fatalf("Failed to create store: %v", err)
	}
	defer store.Close()
	
	engine := New(store, logger)
	ctx := context.Background()
	
	// Create test documents in different collections
	docs := []*docstore.Document{
		{
			ID:         "doc_1",
			ProjectID:  "project1",
			Collection: "users",
			Content:    map[string]interface{}{"name": "Alice"},
		},
		{
			ID:         "doc_2",
			ProjectID:  "project1",
			Collection: "users",
			Content:    map[string]interface{}{"name": "Bob"},
		},
		{
			ID:         "doc_3",
			ProjectID:  "project1",
			Collection: "posts",
			Content:    map[string]interface{}{"title": "Hello World"},
		},
	}
	
	for _, doc := range docs {
		err = store.CreateDocument(ctx, doc)
		if err != nil {
			t.Fatalf("Failed to create document %s: %v", doc.ID, err)
		}
	}
	
	// Test finding in specific collection
	result, err := engine.FindInCollection(ctx, "project1", "users", nil)
	if err != nil {
		t.Fatalf("Failed to find in collection: %v", err)
	}
	
	if len(result.Documents) != 2 {
		t.Errorf("Expected 2 documents in users collection, got %d", len(result.Documents))
	}
	
	// Test with query options
	opts := &QueryOptions{
		Limit:  1,
		Offset: 0,
	}
	
	result, err = engine.FindInCollection(ctx, "project1", "users", opts)
	if err != nil {
		t.Fatalf("Failed to find in collection with options: %v", err)
	}
	
	if len(result.Documents) != 1 {
		t.Errorf("Expected 1 document with limit=1, got %d", len(result.Documents))
	}
	if result.Total != 2 {
		t.Errorf("Expected total=2, got %d", result.Total)
	}
	if !result.HasMore {
		t.Errorf("Expected HasMore=true")
	}
}

func TestQueryEngine_CountDocuments(t *testing.T) {
	// Create temporary directory
	tempDir := t.TempDir()
	
	// Create store and engine
	logger := zerolog.New(os.Stdout)
	store, err := docstore.NewEmbeddedStore(tempDir, logger)
	if err != nil {
		t.Fatalf("Failed to create store: %v", err)
	}
	defer store.Close()
	
	engine := New(store, logger)
	ctx := context.Background()
	
	// Create test documents
	docs := []*docstore.Document{
		{
			ID:         "doc_1",
			ProjectID:  "project1",
			Collection: "users",
			Content:    map[string]interface{}{"status": "active"},
		},
		{
			ID:         "doc_2",
			ProjectID:  "project1",
			Collection: "users",
			Content:    map[string]interface{}{"status": "active"},
		},
		{
			ID:         "doc_3",
			ProjectID:  "project1",
			Collection: "users",
			Content:    map[string]interface{}{"status": "inactive"},
		},
	}
	
	for _, doc := range docs {
		err = store.CreateDocument(ctx, doc)
		if err != nil {
			t.Fatalf("Failed to create document %s: %v", doc.ID, err)
		}
	}
	
	// Count all documents
	count, err := engine.CountDocuments(ctx, "project1", nil)
	if err != nil {
		t.Fatalf("Failed to count documents: %v", err)
	}
	
	if count != 3 {
		t.Errorf("Expected 3 total documents, got %d", count)
	}
	
	// Count with filter
	count, err = engine.CountDocuments(ctx, "project1", map[string]interface{}{"status": "active"})
	if err != nil {
		t.Fatalf("Failed to count filtered documents: %v", err)
	}
	
	if count != 2 {
		t.Errorf("Expected 2 active documents, got %d", count)
	}
}

func TestQueryEngine_ListCollections(t *testing.T) {
	// Create temporary directory
	tempDir := t.TempDir()
	
	// Create store and engine
	logger := zerolog.New(os.Stdout)
	store, err := docstore.NewEmbeddedStore(tempDir, logger)
	if err != nil {
		t.Fatalf("Failed to create store: %v", err)
	}
	defer store.Close()
	
	engine := New(store, logger)
	ctx := context.Background()
	
	// Create test documents in different collections
	docs := []*docstore.Document{
		{
			ID:         "doc_1",
			ProjectID:  "project1",
			Collection: "users",
			Content:    map[string]interface{}{"name": "Alice"},
		},
		{
			ID:         "doc_2",
			ProjectID:  "project1",
			Collection: "posts",
			Content:    map[string]interface{}{"title": "Hello"},
		},
		{
			ID:         "doc_3",
			ProjectID:  "project1",
			Collection: "users",
			Content:    map[string]interface{}{"name": "Bob"},
		},
	}
	
	for _, doc := range docs {
		err = store.CreateDocument(ctx, doc)
		if err != nil {
			t.Fatalf("Failed to create document %s: %v", doc.ID, err)
		}
	}
	
	// List collections
	collections, err := engine.ListCollections(ctx, "project1")
	if err != nil {
		t.Fatalf("Failed to list collections: %v", err)
	}
	
	if len(collections) != 2 {
		t.Errorf("Expected 2 collections, got %d", len(collections))
	}
	
	// Check that both collections are present
	collectionMap := make(map[string]bool)
	for _, collection := range collections {
		collectionMap[collection] = true
	}
	
	if !collectionMap["users"] {
		t.Errorf("Expected 'users' collection to be present")
	}
	if !collectionMap["posts"] {
		t.Errorf("Expected 'posts' collection to be present")
	}
}
// **Feature: shrikdb-phase-1b, Property 8: Pagination correctness**
func TestPaginationCorrectness(t *testing.T) {
	quick.Check(func(totalDocs uint8, limit uint8, offset uint8) bool {
		if totalDocs == 0 || limit == 0 {
			return true // Skip edge cases
		}
		
		// Create temporary directory
		tempDir := t.TempDir()
		
		// Create store and engine
		logger := zerolog.New(os.Stdout)
		store, err := docstore.NewEmbeddedStore(tempDir, logger)
		if err != nil {
			return false
		}
		defer store.Close()
		
		engine := New(store, logger)
		ctx := context.Background()
		
		// Create documents
		for i := uint8(0); i < totalDocs; i++ {
			doc := &docstore.Document{
				ID:         fmt.Sprintf("doc_%d", i),
				ProjectID:  "project1",
				Collection: "test",
				Content:    map[string]interface{}{"index": int(i)},
			}
			
			err = store.CreateDocument(ctx, doc)
			if err != nil {
				return false
			}
		}
		
		// Test pagination
		opts := &QueryOptions{
			Limit:  int(limit),
			Offset: int(offset),
		}
		
		result, err := engine.FindInCollection(ctx, "project1", "test", opts)
		if err != nil {
			return false
		}
		
		// Verify pagination metadata
		if result.Total != int64(totalDocs) {
			return false
		}
		if result.Limit != int(limit) {
			return false
		}
		if result.Offset != int(offset) {
			return false
		}
		
		// Verify result count
		expectedCount := int(limit)
		if int(offset) >= int(totalDocs) {
			expectedCount = 0
		} else if int(offset)+int(limit) > int(totalDocs) {
			expectedCount = int(totalDocs) - int(offset)
		}
		
		if len(result.Documents) != expectedCount {
			return false
		}
		
		// Verify HasMore flag
		expectedHasMore := int(offset)+int(limit) < int(totalDocs)
		if result.HasMore != expectedHasMore {
			return false
		}
		
		return true
	}, &quick.Config{MaxCount: 50})
}