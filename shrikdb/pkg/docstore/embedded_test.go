package docstore

import (
	"context"
	"os"
	"testing"

	"github.com/rs/zerolog"
)

func TestEmbeddedStore_CRUD(t *testing.T) {
	// Create temporary directory
	tempDir := t.TempDir()
	
	// Create store
	logger := zerolog.New(os.Stdout)
	store, err := NewEmbeddedStore(tempDir, logger)
	if err != nil {
		t.Fatalf("Failed to create store: %v", err)
	}
	defer store.Close()
	
	ctx := context.Background()
	
	// Test document creation
	doc := &Document{
		ID:         "doc_123",
		ProjectID:  "project1",
		Collection: "users",
		Content: map[string]interface{}{
			"name":  "John Doe",
			"email": "john@example.com",
			"age":   30,
		},
	}
	
	err = store.CreateDocument(ctx, doc)
	if err != nil {
		t.Fatalf("Failed to create document: %v", err)
	}
	
	// Test document retrieval
	retrieved, err := store.GetDocument(ctx, "doc_123")
	if err != nil {
		t.Fatalf("Failed to get document: %v", err)
	}
	
	if retrieved.ID != doc.ID {
		t.Errorf("ID mismatch: got %v, want %v", retrieved.ID, doc.ID)
	}
	if retrieved.ProjectID != doc.ProjectID {
		t.Errorf("ProjectID mismatch: got %v, want %v", retrieved.ProjectID, doc.ProjectID)
	}
	if retrieved.Collection != doc.Collection {
		t.Errorf("Collection mismatch: got %v, want %v", retrieved.Collection, doc.Collection)
	}
	
	// Test document update
	updates := map[string]interface{}{
		"age":   31,
		"city":  "San Francisco",
	}
	
	err = store.UpdateDocument(ctx, "doc_123", updates)
	if err != nil {
		t.Fatalf("Failed to update document: %v", err)
	}
	
	// Verify update
	updated, err := store.GetDocument(ctx, "doc_123")
	if err != nil {
		t.Fatalf("Failed to get updated document: %v", err)
	}
	
	if updated.Content["age"] != 31 {
		t.Errorf("Age not updated: got %v, want 31", updated.Content["age"])
	}
	if updated.Content["city"] != "San Francisco" {
		t.Errorf("City not added: got %v, want San Francisco", updated.Content["city"])
	}
	if updated.Content["name"] != "John Doe" {
		t.Errorf("Name should be preserved: got %v, want John Doe", updated.Content["name"])
	}
	if updated.Version != 2 {
		t.Errorf("Version not incremented: got %v, want 2", updated.Version)
	}
	
	// Test document deletion
	err = store.DeleteDocument(ctx, "doc_123")
	if err != nil {
		t.Fatalf("Failed to delete document: %v", err)
	}
	
	// Verify deletion
	_, err = store.GetDocument(ctx, "doc_123")
	if err != ErrDocumentNotFound {
		t.Errorf("Expected ErrDocumentNotFound, got %v", err)
	}
}

func TestEmbeddedStore_Query(t *testing.T) {
	// Create temporary directory
	tempDir := t.TempDir()
	
	// Create store
	logger := zerolog.New(os.Stdout)
	store, err := NewEmbeddedStore(tempDir, logger)
	if err != nil {
		t.Fatalf("Failed to create store: %v", err)
	}
	defer store.Close()
	
	ctx := context.Background()
	
	// Create test documents
	docs := []*Document{
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
			Collection: "posts",
			Content:    map[string]interface{}{"title": "Hello", "author": "Alice"},
		},
		{
			ID:         "doc_4",
			ProjectID:  "project2",
			Collection: "users",
			Content:    map[string]interface{}{"name": "Charlie", "age": 35},
		},
	}
	
	for _, doc := range docs {
		err = store.CreateDocument(ctx, doc)
		if err != nil {
			t.Fatalf("Failed to create document %s: %v", doc.ID, err)
		}
	}
	
	// Test query by collection
	query := &Query{
		ProjectID:  "project1",
		Collection: "users",
	}
	
	result, err := store.FindDocuments(ctx, query)
	if err != nil {
		t.Fatalf("Failed to find documents: %v", err)
	}
	
	if len(result.Documents) != 2 {
		t.Errorf("Expected 2 users, got %d", len(result.Documents))
	}
	
	// Test query by field filter
	query = &Query{
		ProjectID: "project1",
		Filters: map[string]interface{}{
			"city": "NYC",
		},
	}
	
	result, err = store.FindDocuments(ctx, query)
	if err != nil {
		t.Fatalf("Failed to find documents by city: %v", err)
	}
	
	if len(result.Documents) != 1 {
		t.Errorf("Expected 1 document with city=NYC, got %d", len(result.Documents))
	}
	if result.Documents[0].Content["name"] != "Alice" {
		t.Errorf("Expected Alice, got %v", result.Documents[0].Content["name"])
	}
	
	// Test pagination
	query = &Query{
		ProjectID:  "project1",
		Collection: "users",
		Limit:      1,
		Offset:     0,
	}
	
	result, err = store.FindDocuments(ctx, query)
	if err != nil {
		t.Fatalf("Failed to find documents with pagination: %v", err)
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

func TestEmbeddedStore_Clear(t *testing.T) {
	// Create temporary directory
	tempDir := t.TempDir()
	
	// Create store
	logger := zerolog.New(os.Stdout)
	store, err := NewEmbeddedStore(tempDir, logger)
	if err != nil {
		t.Fatalf("Failed to create store: %v", err)
	}
	defer store.Close()
	
	ctx := context.Background()
	
	// Create test documents
	doc1 := &Document{
		ID:         "doc_1",
		ProjectID:  "project1",
		Collection: "users",
		Content:    map[string]interface{}{"name": "Alice"},
	}
	doc2 := &Document{
		ID:         "doc_2",
		ProjectID:  "project2",
		Collection: "users",
		Content:    map[string]interface{}{"name": "Bob"},
	}
	
	err = store.CreateDocument(ctx, doc1)
	if err != nil {
		t.Fatalf("Failed to create document 1: %v", err)
	}
	err = store.CreateDocument(ctx, doc2)
	if err != nil {
		t.Fatalf("Failed to create document 2: %v", err)
	}
	
	// Clear project1
	err = store.Clear(ctx, "project1")
	if err != nil {
		t.Fatalf("Failed to clear project1: %v", err)
	}
	
	// Verify project1 documents are gone
	_, err = store.GetDocument(ctx, "doc_1")
	if err != ErrDocumentNotFound {
		t.Errorf("Expected doc_1 to be deleted, got error: %v", err)
	}
	
	// Verify project2 documents still exist
	_, err = store.GetDocument(ctx, "doc_2")
	if err != nil {
		t.Errorf("Expected doc_2 to still exist, got error: %v", err)
	}
}

func TestEmbeddedStore_Stats(t *testing.T) {
	// Create temporary directory
	tempDir := t.TempDir()
	
	// Create store
	logger := zerolog.New(os.Stdout)
	store, err := NewEmbeddedStore(tempDir, logger)
	if err != nil {
		t.Fatalf("Failed to create store: %v", err)
	}
	defer store.Close()
	
	ctx := context.Background()
	
	// Get stats for empty project
	stats, err := store.GetStats(ctx, "project1")
	if err != nil {
		t.Fatalf("Failed to get stats: %v", err)
	}
	
	if stats.DocumentCount != 0 {
		t.Errorf("Expected 0 documents, got %d", stats.DocumentCount)
	}
	if stats.CollectionCount != 0 {
		t.Errorf("Expected 0 collections, got %d", stats.CollectionCount)
	}
	
	// Create test documents
	docs := []*Document{
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
			Content:    map[string]interface{}{"title": "Hello"},
		},
	}
	
	for _, doc := range docs {
		err = store.CreateDocument(ctx, doc)
		if err != nil {
			t.Fatalf("Failed to create document %s: %v", doc.ID, err)
		}
	}
	
	// Get updated stats
	stats, err = store.GetStats(ctx, "project1")
	if err != nil {
		t.Fatalf("Failed to get updated stats: %v", err)
	}
	
	if stats.DocumentCount != 3 {
		t.Errorf("Expected 3 documents, got %d", stats.DocumentCount)
	}
	if stats.CollectionCount != 2 {
		t.Errorf("Expected 2 collections, got %d", stats.CollectionCount)
	}
	if stats.TotalSize <= 0 {
		t.Errorf("Expected positive total size, got %d", stats.TotalSize)
	}
}

func TestEmbeddedStore_Persistence(t *testing.T) {
	// Create temporary directory
	tempDir := t.TempDir()
	
	// Create store and add document
	logger := zerolog.New(os.Stdout)
	store1, err := NewEmbeddedStore(tempDir, logger)
	if err != nil {
		t.Fatalf("Failed to create store: %v", err)
	}
	
	ctx := context.Background()
	doc := &Document{
		ID:         "doc_123",
		ProjectID:  "project1",
		Collection: "users",
		Content:    map[string]interface{}{"name": "Alice"},
	}
	
	err = store1.CreateDocument(ctx, doc)
	if err != nil {
		t.Fatalf("Failed to create document: %v", err)
	}
	
	store1.Close()
	
	// Create new store instance and verify document persisted
	store2, err := NewEmbeddedStore(tempDir, logger)
	if err != nil {
		t.Fatalf("Failed to create second store: %v", err)
	}
	defer store2.Close()
	
	retrieved, err := store2.GetDocument(ctx, "doc_123")
	if err != nil {
		t.Fatalf("Failed to get persisted document: %v", err)
	}
	
	if retrieved.ID != doc.ID {
		t.Errorf("ID mismatch: got %v, want %v", retrieved.ID, doc.ID)
	}
	if retrieved.Content["name"] != "Alice" {
		t.Errorf("Content mismatch: got %v, want Alice", retrieved.Content["name"])
	}
}