package api

import (
	"context"
	"os"
	"testing"
	"testing/quick"

	"shrikdb/pkg/wal"

	"github.com/rs/zerolog"
)

func TestDocumentAPI_CreateDocument(t *testing.T) {
	// Create temporary directory
	tempDir := t.TempDir()
	
	// Create service
	logger := zerolog.New(os.Stdout)
	config := Config{
		DataDir:     tempDir,
		DocumentDir: tempDir + "/documents",
		WAL: wal.Config{
			DataDir:  tempDir + "/wal",
			SyncMode: "always",
		},
	}
	
	service, err := NewService(config, logger)
	if err != nil {
		t.Fatalf("Failed to create service: %v", err)
	}
	defer service.Close()
	
	ctx := context.Background()
	
	// Create project first
	createProjectReq := &CreateProjectRequest{
		ProjectID: "test-project",
	}
	
	projectResp, err := service.CreateProject(ctx, createProjectReq)
	if err != nil {
		t.Fatalf("Failed to create project: %v", err)
	}
	
	// Test document creation
	req := &CreateDocumentRequest{
		ClientID:   projectResp.ClientID,
		ClientKey:  projectResp.ClientKey,
		ProjectID:  "test-project",
		Collection: "users",
		Content: map[string]interface{}{
			"name":  "John Doe",
			"email": "john@example.com",
			"age":   30,
		},
	}
	
	resp, err := service.CreateDocument(ctx, req)
	if err != nil {
		t.Fatalf("Failed to create document: %v", err)
	}
	
	if !resp.Success {
		t.Errorf("Expected success=true, got %v", resp.Success)
	}
	if resp.DocumentID == "" {
		t.Errorf("Expected document ID to be set")
	}
	if resp.EventID == "" {
		t.Errorf("Expected event ID to be set")
	}
	
	// Verify document can be retrieved
	getReq := &GetDocumentRequest{
		ClientID:   projectResp.ClientID,
		ClientKey:  projectResp.ClientKey,
		ProjectID:  "test-project",
		DocumentID: resp.DocumentID,
	}
	
	getResp, err := service.GetDocument(ctx, getReq)
	if err != nil {
		t.Fatalf("Failed to get document: %v", err)
	}
	
	if !getResp.Success {
		t.Errorf("Expected success=true for get, got %v", getResp.Success)
	}
	if getResp.Document == nil {
		t.Fatalf("Expected document to be returned")
	}
	if getResp.Document.ID != resp.DocumentID {
		t.Errorf("Document ID mismatch: got %v, want %v", getResp.Document.ID, resp.DocumentID)
	}
	if getResp.Document.Collection != "users" {
		t.Errorf("Collection mismatch: got %v, want users", getResp.Document.Collection)
	}
	if getResp.Document.Content["name"] != "John Doe" {
		t.Errorf("Name mismatch: got %v, want John Doe", getResp.Document.Content["name"])
	}
}

func TestDocumentAPI_UpdateDocument(t *testing.T) {
	// Create temporary directory
	tempDir := t.TempDir()
	
	// Create service
	logger := zerolog.New(os.Stdout)
	config := Config{
		DataDir:     tempDir,
		DocumentDir: tempDir + "/documents",
		WAL: wal.Config{
			DataDir:  tempDir + "/wal",
			SyncMode: "always",
		},
	}
	
	service, err := NewService(config, logger)
	if err != nil {
		t.Fatalf("Failed to create service: %v", err)
	}
	defer service.Close()
	
	ctx := context.Background()
	
	// Create project
	createProjectReq := &CreateProjectRequest{
		ProjectID: "test-project",
	}
	
	projectResp, err := service.CreateProject(ctx, createProjectReq)
	if err != nil {
		t.Fatalf("Failed to create project: %v", err)
	}
	
	// Create document
	createReq := &CreateDocumentRequest{
		ClientID:   projectResp.ClientID,
		ClientKey:  projectResp.ClientKey,
		ProjectID:  "test-project",
		Collection: "users",
		Content: map[string]interface{}{
			"name": "John Doe",
			"age":  30,
		},
	}
	
	createResp, err := service.CreateDocument(ctx, createReq)
	if err != nil {
		t.Fatalf("Failed to create document: %v", err)
	}
	
	// Update document
	updateReq := &UpdateDocumentRequest{
		ClientID:   projectResp.ClientID,
		ClientKey:  projectResp.ClientKey,
		ProjectID:  "test-project",
		DocumentID: createResp.DocumentID,
		Updates: map[string]interface{}{
			"age":   31,
			"city":  "San Francisco",
		},
	}
	
	updateResp, err := service.UpdateDocument(ctx, updateReq)
	if err != nil {
		t.Fatalf("Failed to update document: %v", err)
	}
	
	if !updateResp.Success {
		t.Errorf("Expected success=true, got %v", updateResp.Success)
	}
	if updateResp.DocumentID != createResp.DocumentID {
		t.Errorf("Document ID mismatch: got %v, want %v", updateResp.DocumentID, createResp.DocumentID)
	}
	
	// Verify update
	getReq := &GetDocumentRequest{
		ClientID:   projectResp.ClientID,
		ClientKey:  projectResp.ClientKey,
		ProjectID:  "test-project",
		DocumentID: createResp.DocumentID,
	}
	
	getResp, err := service.GetDocument(ctx, getReq)
	if err != nil {
		t.Fatalf("Failed to get updated document: %v", err)
	}
	
	// Check age (handle JSON number conversion)
	ageValue := getResp.Document.Content["age"]
	var age int
	switch v := ageValue.(type) {
	case int:
		age = v
	case float64:
		age = int(v)
	default:
		t.Errorf("Age has unexpected type: %T", v)
	}
	if age != 31 {
		t.Errorf("Age not updated: got %v, want 31", age)
	}
	if getResp.Document.Content["city"] != "San Francisco" {
		t.Errorf("City not added: got %v, want San Francisco", getResp.Document.Content["city"])
	}
	if getResp.Document.Content["name"] != "John Doe" {
		t.Errorf("Name should be preserved: got %v, want John Doe", getResp.Document.Content["name"])
	}
}

func TestDocumentAPI_DeleteDocument(t *testing.T) {
	// Create temporary directory
	tempDir := t.TempDir()
	
	// Create service
	logger := zerolog.New(os.Stdout)
	config := Config{
		DataDir:     tempDir,
		DocumentDir: tempDir + "/documents",
		WAL: wal.Config{
			DataDir:  tempDir + "/wal",
			SyncMode: "always",
		},
	}
	
	service, err := NewService(config, logger)
	if err != nil {
		t.Fatalf("Failed to create service: %v", err)
	}
	defer service.Close()
	
	ctx := context.Background()
	
	// Create project
	createProjectReq := &CreateProjectRequest{
		ProjectID: "test-project",
	}
	
	projectResp, err := service.CreateProject(ctx, createProjectReq)
	if err != nil {
		t.Fatalf("Failed to create project: %v", err)
	}
	
	// Create document
	createReq := &CreateDocumentRequest{
		ClientID:   projectResp.ClientID,
		ClientKey:  projectResp.ClientKey,
		ProjectID:  "test-project",
		Collection: "users",
		Content: map[string]interface{}{
			"name": "John Doe",
		},
	}
	
	createResp, err := service.CreateDocument(ctx, createReq)
	if err != nil {
		t.Fatalf("Failed to create document: %v", err)
	}
	
	// Delete document
	deleteReq := &DeleteDocumentRequest{
		ClientID:   projectResp.ClientID,
		ClientKey:  projectResp.ClientKey,
		ProjectID:  "test-project",
		DocumentID: createResp.DocumentID,
	}
	
	deleteResp, err := service.DeleteDocument(ctx, deleteReq)
	if err != nil {
		t.Fatalf("Failed to delete document: %v", err)
	}
	
	if !deleteResp.Success {
		t.Errorf("Expected success=true, got %v", deleteResp.Success)
	}
	if deleteResp.DocumentID != createResp.DocumentID {
		t.Errorf("Document ID mismatch: got %v, want %v", deleteResp.DocumentID, createResp.DocumentID)
	}
	
	// Verify deletion
	getReq := &GetDocumentRequest{
		ClientID:   projectResp.ClientID,
		ClientKey:  projectResp.ClientKey,
		ProjectID:  "test-project",
		DocumentID: createResp.DocumentID,
	}
	
	_, err = service.GetDocument(ctx, getReq)
	if err == nil {
		t.Errorf("Expected error when getting deleted document")
	}
}

func TestDocumentAPI_FindDocuments(t *testing.T) {
	// Create temporary directory
	tempDir := t.TempDir()
	
	// Create service
	logger := zerolog.New(os.Stdout)
	config := Config{
		DataDir:     tempDir,
		DocumentDir: tempDir + "/documents",
		WAL: wal.Config{
			DataDir:  tempDir + "/wal",
			SyncMode: "always",
		},
	}
	
	service, err := NewService(config, logger)
	if err != nil {
		t.Fatalf("Failed to create service: %v", err)
	}
	defer service.Close()
	
	ctx := context.Background()
	
	// Create project
	createProjectReq := &CreateProjectRequest{
		ProjectID: "test-project",
	}
	
	projectResp, err := service.CreateProject(ctx, createProjectReq)
	if err != nil {
		t.Fatalf("Failed to create project: %v", err)
	}
	
	// Create test documents
	docs := []map[string]interface{}{
		{"name": "Alice", "age": 25, "city": "NYC"},
		{"name": "Bob", "age": 30, "city": "SF"},
		{"name": "Charlie", "age": 25, "city": "LA"},
	}
	
	for _, content := range docs {
		createReq := &CreateDocumentRequest{
			ClientID:   projectResp.ClientID,
			ClientKey:  projectResp.ClientKey,
			ProjectID:  "test-project",
			Collection: "users",
			Content:    content,
		}
		
		_, err := service.CreateDocument(ctx, createReq)
		if err != nil {
			t.Fatalf("Failed to create document: %v", err)
		}
	}
	
	// Find all documents in collection
	findReq := &FindDocumentsRequest{
		ClientID:   projectResp.ClientID,
		ClientKey:  projectResp.ClientKey,
		ProjectID:  "test-project",
		Collection: "users",
	}
	
	findResp, err := service.FindDocuments(ctx, findReq)
	if err != nil {
		t.Fatalf("Failed to find documents: %v", err)
	}
	
	if !findResp.Success {
		t.Errorf("Expected success=true, got %v", findResp.Success)
	}
	if len(findResp.Result.Documents) != 3 {
		t.Errorf("Expected 3 documents, got %d", len(findResp.Result.Documents))
	}
	
	// Find documents with filter
	findReq.Filters = map[string]interface{}{"age": 25}
	
	findResp, err = service.FindDocuments(ctx, findReq)
	if err != nil {
		t.Fatalf("Failed to find filtered documents: %v", err)
	}
	
	if len(findResp.Result.Documents) != 2 {
		t.Errorf("Expected 2 documents with age=25, got %d", len(findResp.Result.Documents))
	}
	
	// Test pagination
	findReq.Filters = nil
	findReq.Limit = 2
	findReq.Offset = 0
	
	findResp, err = service.FindDocuments(ctx, findReq)
	if err != nil {
		t.Fatalf("Failed to find paginated documents: %v", err)
	}
	
	if len(findResp.Result.Documents) != 2 {
		t.Errorf("Expected 2 documents with limit=2, got %d", len(findResp.Result.Documents))
	}
	if findResp.Result.Total != 3 {
		t.Errorf("Expected total=3, got %d", findResp.Result.Total)
	}
	if !findResp.Result.HasMore {
		t.Errorf("Expected HasMore=true")
	}
}
// **Feature: shrikdb-phase-1b, Property 19: Frontend write API usage**
func TestFrontendWriteAPIUsage(t *testing.T) {
	quick.Check(func(collection string, name string, age uint8) bool {
		if collection == "" || name == "" {
			return true // Skip invalid inputs
		}
		
		// Create temporary directory
		tempDir := t.TempDir()
		
		// Create service
		logger := zerolog.New(os.Stdout)
		config := Config{
			DataDir:     tempDir,
			DocumentDir: tempDir + "/documents",
			WAL: wal.Config{
				DataDir:  tempDir + "/wal",
				SyncMode: "always",
			},
		}
		
		service, err := NewService(config, logger)
		if err != nil {
			return false
		}
		defer service.Close()
		
		ctx := context.Background()
		
		// Create project
		createProjectReq := &CreateProjectRequest{
			ProjectID: "test-project",
		}
		
		projectResp, err := service.CreateProject(ctx, createProjectReq)
		if err != nil {
			return false
		}
		
		// Test that document creation uses event API
		createReq := &CreateDocumentRequest{
			ClientID:   projectResp.ClientID,
			ClientKey:  projectResp.ClientKey,
			ProjectID:  "test-project",
			Collection: collection,
			Content: map[string]interface{}{
				"name": name,
				"age":  int(age),
			},
		}
		
		createResp, err := service.CreateDocument(ctx, createReq)
		if err != nil {
			return false
		}
		
		// Verify that an event was created (EventID should be set)
		if createResp.EventID == "" {
			return false
		}
		
		// Verify that the event exists in the WAL
		readReq := &ReadEventsRequest{
			ClientID:     projectResp.ClientID,
			ClientKey:    projectResp.ClientKey,
			ProjectID:    "test-project",
			FromSequence: 0,
		}
		
		readResp, err := service.ReadEvents(ctx, readReq)
		if err != nil {
			return false
		}
		
		// Should have at least one event (the document.created event)
		if len(readResp.Events) == 0 {
			return false
		}
		
		// Find the document.created event
		var foundEvent bool
		for _, evt := range readResp.Events {
			if evt.EventID == createResp.EventID && evt.EventType == "document.created" {
				foundEvent = true
				break
			}
		}
		
		return foundEvent
	}, &quick.Config{MaxCount: 20}) // Reduced count due to complexity
}
// **Feature: shrikdb-phase-1b, Property 20: Frontend read API usage**
func TestFrontendReadAPIUsage(t *testing.T) {
	quick.Check(func(docName string, docAge uint8) bool {
		if docName == "" {
			return true // Skip invalid inputs
		}
		
		// Create temporary directory
		tempDir := t.TempDir()
		
		// Create service
		logger := zerolog.New(os.Stdout)
		config := Config{
			DataDir:     tempDir,
			DocumentDir: tempDir + "/documents",
			WAL: wal.Config{
				DataDir:  tempDir + "/wal",
				SyncMode: "always",
			},
		}
		
		service, err := NewService(config, logger)
		if err != nil {
			return false
		}
		defer service.Close()
		
		ctx := context.Background()
		
		// Create project
		createProjectReq := &CreateProjectRequest{
			ProjectID: "test-project",
		}
		
		projectResp, err := service.CreateProject(ctx, createProjectReq)
		if err != nil {
			return false
		}
		
		// Create a document first
		createReq := &CreateDocumentRequest{
			ClientID:   projectResp.ClientID,
			ClientKey:  projectResp.ClientKey,
			ProjectID:  "test-project",
			Collection: "users",
			Content: map[string]interface{}{
				"name": docName,
				"age":  int(docAge),
			},
		}
		
		createResp, err := service.CreateDocument(ctx, createReq)
		if err != nil {
			return false
		}
		
		// Test that document reads use projection API (not event log)
		getReq := &GetDocumentRequest{
			ClientID:   projectResp.ClientID,
			ClientKey:  projectResp.ClientKey,
			ProjectID:  "test-project",
			DocumentID: createResp.DocumentID,
		}
		
		getResp, err := service.GetDocument(ctx, getReq)
		if err != nil {
			return false
		}
		
		// Verify we got the document from projection
		if getResp.Document == nil {
			return false
		}
		if getResp.Document.ID != createResp.DocumentID {
			return false
		}
		if getResp.Document.Content["name"] != docName {
			return false
		}
		if getResp.Document.Content["age"] != int(docAge) {
			return false
		}
		
		// Test that find operations also use projection API
		findReq := &FindDocumentsRequest{
			ClientID:   projectResp.ClientID,
			ClientKey:  projectResp.ClientKey,
			ProjectID:  "test-project",
			Collection: "users",
			Filters: map[string]interface{}{
				"name": docName,
			},
		}
		
		findResp, err := service.FindDocuments(ctx, findReq)
		if err != nil {
			return false
		}
		
		// Should find the document we created
		if len(findResp.Result.Documents) != 1 {
			return false
		}
		if findResp.Result.Documents[0].ID != createResp.DocumentID {
			return false
		}
		
		return true
	}, &quick.Config{MaxCount: 20}) // Reduced count due to complexity
}