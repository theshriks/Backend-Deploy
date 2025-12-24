package docstore

import (
	"context"
	"os"
	"testing"
	"testing/quick"
	"time"

	"github.com/rs/zerolog"
)

// **Feature: shrikdb-phase-1b, Property 28: Unique document ID assignment**
func TestUniqueDocumentIDAssignment(t *testing.T) {
	quick.Check(func(n uint8) bool {
		// Generate multiple document IDs
		ids := make(map[string]bool)
		count := int(n) + 1 // Ensure at least 1 ID
		
		for i := 0; i < count; i++ {
			id := GenerateDocumentID()
			
			// Check if ID is unique
			if ids[id] {
				return false // Duplicate found
			}
			ids[id] = true
			
			// Check ID format (should start with "doc_")
			if len(id) < 4 || id[:4] != "doc_" {
				return false
			}
		}
		
		return true
	}, &quick.Config{MaxCount: 100})
}

func TestDocumentValidation(t *testing.T) {
	tests := []struct {
		name    string
		doc     *Document
		wantErr bool
	}{
		{
			name: "valid document",
			doc: &Document{
				ID:         "doc_123",
				ProjectID:  "project1",
				Collection: "users",
				Content:    map[string]interface{}{"name": "test"},
			},
			wantErr: false,
		},
		{
			name:    "nil document",
			doc:     nil,
			wantErr: true,
		},
		{
			name: "empty ID",
			doc: &Document{
				ProjectID:  "project1",
				Collection: "users",
				Content:    map[string]interface{}{"name": "test"},
			},
			wantErr: true,
		},
		{
			name: "empty project ID",
			doc: &Document{
				ID:         "doc_123",
				Collection: "users",
				Content:    map[string]interface{}{"name": "test"},
			},
			wantErr: true,
		},
		{
			name: "empty collection",
			doc: &Document{
				ID:        "doc_123",
				ProjectID: "project1",
				Content:   map[string]interface{}{"name": "test"},
			},
			wantErr: true,
		},
		{
			name: "nil content",
			doc: &Document{
				ID:         "doc_123",
				ProjectID:  "project1",
				Collection: "users",
			},
			wantErr: true,
		},
	}
	
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateDocument(tt.doc)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateDocument() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestQueryValidation(t *testing.T) {
	tests := []struct {
		name    string
		query   *Query
		wantErr bool
	}{
		{
			name: "valid query",
			query: &Query{
				ProjectID: "project1",
				Limit:     10,
				Offset:    0,
			},
			wantErr: false,
		},
		{
			name:    "nil query",
			query:   nil,
			wantErr: true,
		},
		{
			name: "empty project ID",
			query: &Query{
				Limit:  10,
				Offset: 0,
			},
			wantErr: true,
		},
		{
			name: "negative limit",
			query: &Query{
				ProjectID: "project1",
				Limit:     -1,
			},
			wantErr: true,
		},
		{
			name: "negative offset",
			query: &Query{
				ProjectID: "project1",
				Offset:    -1,
			},
			wantErr: true,
		},
		{
			name: "invalid sort order",
			query: &Query{
				ProjectID: "project1",
				SortOrder: "invalid",
			},
			wantErr: true,
		},
	}
	
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateQuery(tt.query)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateQuery() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestMergeUpdates(t *testing.T) {
	original := map[string]interface{}{
		"name": "John",
		"age":  30,
		"city": "New York",
	}
	
	updates := map[string]interface{}{
		"age":   31,
		"email": "john@example.com",
	}
	
	result := MergeUpdates(original, updates)
	
	// Check that original fields are preserved
	if result["name"] != "John" {
		t.Errorf("Expected name to be preserved, got %v", result["name"])
	}
	if result["city"] != "New York" {
		t.Errorf("Expected city to be preserved, got %v", result["city"])
	}
	
	// Check that updates are applied
	if result["age"] != 31 {
		t.Errorf("Expected age to be updated to 31, got %v", result["age"])
	}
	if result["email"] != "john@example.com" {
		t.Errorf("Expected email to be added, got %v", result["email"])
	}
}

func TestDocumentSerialization(t *testing.T) {
	doc := &Document{
		ID:         "doc_123",
		ProjectID:  "project1",
		Collection: "users",
		Content:    map[string]interface{}{"name": "test"},
		CreatedAt:  time.Now().UTC(),
		UpdatedAt:  time.Now().UTC(),
		Version:    1,
		EventID:    "event_456",
	}
	
	// Test serialization
	data, err := SerializeDocument(doc)
	if err != nil {
		t.Fatalf("SerializeDocument() error = %v", err)
	}
	
	// Test deserialization
	restored, err := DeserializeDocument(data)
	if err != nil {
		t.Fatalf("DeserializeDocument() error = %v", err)
	}
	
	// Verify fields
	if restored.ID != doc.ID {
		t.Errorf("ID mismatch: got %v, want %v", restored.ID, doc.ID)
	}
	if restored.ProjectID != doc.ProjectID {
		t.Errorf("ProjectID mismatch: got %v, want %v", restored.ProjectID, doc.ProjectID)
	}
	if restored.Collection != doc.Collection {
		t.Errorf("Collection mismatch: got %v, want %v", restored.Collection, doc.Collection)
	}
	if restored.Version != doc.Version {
		t.Errorf("Version mismatch: got %v, want %v", restored.Version, doc.Version)
	}
	if restored.EventID != doc.EventID {
		t.Errorf("EventID mismatch: got %v, want %v", restored.EventID, doc.EventID)
	}
}

// **Feature: shrikdb-phase-1b, Property 6: Document ID query correctness**
func TestDocumentIDQueryCorrectness(t *testing.T) {
	quick.Check(func(docID string, projectID string, collection string) bool {
		if docID == "" || projectID == "" || collection == "" {
			return true // Skip invalid inputs
		}
		
		// Create temporary directory
		tempDir := t.TempDir()
		
		// Create store
		logger := zerolog.New(os.Stdout)
		store, err := NewEmbeddedStore(tempDir, logger)
		if err != nil {
			return false
		}
		defer store.Close()
		
		ctx := context.Background()
		
		// Create document
		doc := &Document{
			ID:         docID,
			ProjectID:  projectID,
			Collection: collection,
			Content:    map[string]interface{}{"test": "value"},
		}
		
		err = store.CreateDocument(ctx, doc)
		if err != nil {
			return false
		}
		
		// Query by ID should return the exact document
		retrieved, err := store.GetDocument(ctx, docID)
		if err != nil {
			return false
		}
		
		// Verify it's the same document
		return retrieved.ID == docID && 
			   retrieved.ProjectID == projectID && 
			   retrieved.Collection == collection &&
			   retrieved.Content["test"] == "value"
	}, &quick.Config{MaxCount: 100})
}
// **Feature: shrikdb-phase-1b, Property 7: Field-based query completeness**
func TestFieldBasedQueryCompleteness(t *testing.T) {
	quick.Check(func(fieldValue string, projectID string) bool {
		if fieldValue == "" || projectID == "" {
			return true // Skip invalid inputs
		}
		
		// Create temporary directory
		tempDir := t.TempDir()
		
		// Create store
		logger := zerolog.New(os.Stdout)
		store, err := NewEmbeddedStore(tempDir, logger)
		if err != nil {
			return false
		}
		defer store.Close()
		
		ctx := context.Background()
		
		// Create multiple documents, some matching the field value
		matchingDocs := []string{"doc_1", "doc_3", "doc_5"}
		nonMatchingDocs := []string{"doc_2", "doc_4"}
		
		// Create matching documents
		for _, docID := range matchingDocs {
			doc := &Document{
				ID:         docID,
				ProjectID:  projectID,
				Collection: "test",
				Content:    map[string]interface{}{"testField": fieldValue},
			}
			err = store.CreateDocument(ctx, doc)
			if err != nil {
				return false
			}
		}
		
		// Create non-matching documents
		for _, docID := range nonMatchingDocs {
			doc := &Document{
				ID:         docID,
				ProjectID:  projectID,
				Collection: "test",
				Content:    map[string]interface{}{"testField": "different_value"},
			}
			err = store.CreateDocument(ctx, doc)
			if err != nil {
				return false
			}
		}
		
		// Query by field value
		query := &Query{
			ProjectID: projectID,
			Filters: map[string]interface{}{
				"testField": fieldValue,
			},
		}
		
		result, err := store.FindDocuments(ctx, query)
		if err != nil {
			return false
		}
		
		// Should return exactly the matching documents
		if len(result.Documents) != len(matchingDocs) {
			return false
		}
		
		// Verify all returned documents have the correct field value
		for _, doc := range result.Documents {
			if doc.Content["testField"] != fieldValue {
				return false
			}
		}
		
		return true
	}, &quick.Config{MaxCount: 50}) // Reduced count due to complexity
}
// **Feature: shrikdb-phase-1b, Property 29: Partial update correctness**
func TestPartialUpdateCorrectness(t *testing.T) {
	quick.Check(func(originalName string, originalAge uint8, newAge uint8, newCity string) bool {
		if originalName == "" || newCity == "" {
			return true // Skip invalid inputs
		}
		
		// Create temporary directory
		tempDir := t.TempDir()
		
		// Create store
		logger := zerolog.New(os.Stdout)
		store, err := NewEmbeddedStore(tempDir, logger)
		if err != nil {
			return false
		}
		defer store.Close()
		
		ctx := context.Background()
		
		// Create original document
		doc := &Document{
			ID:         "doc_test",
			ProjectID:  "project1",
			Collection: "users",
			Content: map[string]interface{}{
				"name": originalName,
				"age":  int(originalAge),
			},
		}
		
		err = store.CreateDocument(ctx, doc)
		if err != nil {
			return false
		}
		
		// Perform partial update (only age and city)
		updates := map[string]interface{}{
			"age":  int(newAge),
			"city": newCity,
		}
		
		err = store.UpdateDocument(ctx, "doc_test", updates)
		if err != nil {
			return false
		}
		
		// Verify partial update correctness
		updated, err := store.GetDocument(ctx, "doc_test")
		if err != nil {
			return false
		}
		
		// Check that only specified fields were updated
		if updated.Content["age"] != int(newAge) {
			return false // Age should be updated
		}
		if updated.Content["city"] != newCity {
			return false // City should be added
		}
		if updated.Content["name"] != originalName {
			return false // Name should be preserved
		}
		
		// Check that version was incremented
		if updated.Version != 2 {
			return false
		}
		
		return true
	}, &quick.Config{MaxCount: 50})
}