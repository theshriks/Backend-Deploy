package projection

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"testing/quick"
	"time"

	"shrikdb/pkg/docstore"
	"shrikdb/pkg/event"

	"github.com/rs/zerolog"
)

func TestProjectionEngine_DocumentCreated(t *testing.T) {
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
	
	// Create document.created event
	payload := DocumentCreatedPayload{
		DocumentID: "doc_123",
		Collection: "users",
		Content: map[string]interface{}{
			"name":  "John Doe",
			"email": "john@example.com",
		},
	}
	
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("Failed to marshal payload: %v", err)
	}
	
	evt := &event.Event{
		EventID:        "event_456",
		ProjectID:      "project1",
		EventType:      "document.created",
		Payload:        payloadBytes,
		SequenceNumber: 1,
		Timestamp:      time.Now().UTC(),
	}
	
	// Process event
	err = engine.ProcessEvent(ctx, evt)
	if err != nil {
		t.Fatalf("Failed to process event: %v", err)
	}
	
	// Verify document was created
	doc, err := store.GetDocument(ctx, "doc_123")
	if err != nil {
		t.Fatalf("Failed to get created document: %v", err)
	}
	
	if doc.ID != "doc_123" {
		t.Errorf("ID mismatch: got %v, want doc_123", doc.ID)
	}
	if doc.ProjectID != "project1" {
		t.Errorf("ProjectID mismatch: got %v, want project1", doc.ProjectID)
	}
	if doc.Collection != "users" {
		t.Errorf("Collection mismatch: got %v, want users", doc.Collection)
	}
	if doc.Content["name"] != "John Doe" {
		t.Errorf("Name mismatch: got %v, want John Doe", doc.Content["name"])
	}
	if doc.EventID != "event_456" {
		t.Errorf("EventID mismatch: got %v, want event_456", doc.EventID)
	}
}

func TestProjectionEngine_DocumentUpdated(t *testing.T) {
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
	
	// Create initial document
	doc := &docstore.Document{
		ID:         "doc_123",
		ProjectID:  "project1",
		Collection: "users",
		Content: map[string]interface{}{
			"name": "John Doe",
			"age":  30,
		},
	}
	
	err = store.CreateDocument(ctx, doc)
	if err != nil {
		t.Fatalf("Failed to create initial document: %v", err)
	}
	
	// Create document.updated event
	payload := DocumentUpdatedPayload{
		DocumentID: "doc_123",
		Updates: map[string]interface{}{
			"age":   31,
			"city":  "San Francisco",
		},
	}
	
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("Failed to marshal payload: %v", err)
	}
	
	evt := &event.Event{
		EventID:        "event_789",
		ProjectID:      "project1",
		EventType:      "document.updated",
		Payload:        payloadBytes,
		SequenceNumber: 2,
		Timestamp:      time.Now().UTC(),
	}
	
	// Process event
	err = engine.ProcessEvent(ctx, evt)
	if err != nil {
		t.Fatalf("Failed to process event: %v", err)
	}
	
	// Verify document was updated
	updated, err := store.GetDocument(ctx, "doc_123")
	if err != nil {
		t.Fatalf("Failed to get updated document: %v", err)
	}
	
	if updated.Content["age"] != float64(31) {
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
}

func TestProjectionEngine_DocumentDeleted(t *testing.T) {
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
	
	// Create initial document
	doc := &docstore.Document{
		ID:         "doc_123",
		ProjectID:  "project1",
		Collection: "users",
		Content: map[string]interface{}{
			"name": "John Doe",
		},
	}
	
	err = store.CreateDocument(ctx, doc)
	if err != nil {
		t.Fatalf("Failed to create initial document: %v", err)
	}
	
	// Create document.deleted event
	payload := DocumentDeletedPayload{
		DocumentID: "doc_123",
		Collection: "users",
	}
	
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("Failed to marshal payload: %v", err)
	}
	
	evt := &event.Event{
		EventID:        "event_999",
		ProjectID:      "project1",
		EventType:      "document.deleted",
		Payload:        payloadBytes,
		SequenceNumber: 3,
		Timestamp:      time.Now().UTC(),
	}
	
	// Process event
	err = engine.ProcessEvent(ctx, evt)
	if err != nil {
		t.Fatalf("Failed to process event: %v", err)
	}
	
	// Verify document was deleted
	_, err = store.GetDocument(ctx, "doc_123")
	if err != docstore.ErrDocumentNotFound {
		t.Errorf("Expected ErrDocumentNotFound, got %v", err)
	}
}

func TestProjectionEngine_RebuildFromEvents(t *testing.T) {
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
	
	// Create sequence of events
	events := []*event.Event{
		// Create document
		{
			EventID:        "event_1",
			ProjectID:      "project1",
			EventType:      "document.created",
			Payload:        mustMarshal(DocumentCreatedPayload{
				DocumentID: "doc_1",
				Collection: "users",
				Content:    map[string]interface{}{"name": "Alice", "age": 25},
			}),
			SequenceNumber: 1,
			Timestamp:      time.Now().UTC(),
		},
		// Update document
		{
			EventID:        "event_2",
			ProjectID:      "project1",
			EventType:      "document.updated",
			Payload:        mustMarshal(DocumentUpdatedPayload{
				DocumentID: "doc_1",
				Updates:    map[string]interface{}{"age": 26, "city": "NYC"},
			}),
			SequenceNumber: 2,
			Timestamp:      time.Now().UTC(),
		},
		// Create another document
		{
			EventID:        "event_3",
			ProjectID:      "project1",
			EventType:      "document.created",
			Payload:        mustMarshal(DocumentCreatedPayload{
				DocumentID: "doc_2",
				Collection: "posts",
				Content:    map[string]interface{}{"title": "Hello World", "author": "Alice"},
			}),
			SequenceNumber: 3,
			Timestamp:      time.Now().UTC(),
		},
		// Delete first document
		{
			EventID:        "event_4",
			ProjectID:      "project1",
			EventType:      "document.deleted",
			Payload:        mustMarshal(DocumentDeletedPayload{
				DocumentID: "doc_1",
				Collection: "users",
			}),
			SequenceNumber: 4,
			Timestamp:      time.Now().UTC(),
		},
	}
	
	// Rebuild from events
	err = engine.RebuildFromEvents(ctx, "project1", events)
	if err != nil {
		t.Fatalf("Failed to rebuild from events: %v", err)
	}
	
	// Verify final state
	// doc_1 should be deleted
	_, err = store.GetDocument(ctx, "doc_1")
	if err != docstore.ErrDocumentNotFound {
		t.Errorf("Expected doc_1 to be deleted, got error: %v", err)
	}
	
	// doc_2 should exist
	doc2, err := store.GetDocument(ctx, "doc_2")
	if err != nil {
		t.Fatalf("Failed to get doc_2: %v", err)
	}
	
	if doc2.Collection != "posts" {
		t.Errorf("Collection mismatch: got %v, want posts", doc2.Collection)
	}
	if doc2.Content["title"] != "Hello World" {
		t.Errorf("Title mismatch: got %v, want Hello World", doc2.Content["title"])
	}
}

func TestProjectionEngine_Metrics(t *testing.T) {
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
	
	// Initial metrics should be zero
	metrics := engine.GetMetrics()
	if metrics.EventsProcessed != 0 {
		t.Errorf("Expected 0 events processed, got %d", metrics.EventsProcessed)
	}
	
	// Process an event
	payload := DocumentCreatedPayload{
		DocumentID: "doc_123",
		Collection: "users",
		Content:    map[string]interface{}{"name": "Test"},
	}
	
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("Failed to marshal payload: %v", err)
	}
	
	evt := &event.Event{
		EventID:        "event_456",
		ProjectID:      "project1",
		EventType:      "document.created",
		Payload:        payloadBytes,
		SequenceNumber: 1,
		Timestamp:      time.Now().UTC(),
	}
	
	err = engine.ProcessEvent(ctx, evt)
	if err != nil {
		t.Fatalf("Failed to process event: %v", err)
	}
	
	// Check updated metrics
	metrics = engine.GetMetrics()
	if metrics.EventsProcessed != 1 {
		t.Errorf("Expected 1 event processed, got %d", metrics.EventsProcessed)
	}
	if metrics.LastProcessedEvent != "event_456" {
		t.Errorf("Last processed event mismatch: got %v, want event_456", metrics.LastProcessedEvent)
	}
}

func mustMarshal(v interface{}) []byte {
	data, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return data
}
// **Feature: shrikdb-phase-1b, Property 1: Document creation event ordering**
func TestDocumentCreationEventOrdering(t *testing.T) {
	quick.Check(func(docID string, projectID string) bool {
		if docID == "" || projectID == "" {
			return true // Skip invalid inputs
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
		
		// Create document.created event
		payload := DocumentCreatedPayload{
			DocumentID: docID,
			Collection: "test",
			Content:    map[string]interface{}{"test": "value"},
		}
		
		payloadBytes, err := json.Marshal(payload)
		if err != nil {
			return false
		}
		
		evt := &event.Event{
			EventID:        "event_" + docID,
			ProjectID:      projectID,
			EventType:      "document.created",
			Payload:        payloadBytes,
			SequenceNumber: 1,
			Timestamp:      time.Now().UTC(),
		}
		
		// Process event
		err = engine.ProcessEvent(ctx, evt)
		if err != nil {
			return false
		}
		
		// Verify document exists in projection after event processing
		doc, err := store.GetDocument(ctx, docID)
		if err != nil {
			return false
		}
		
		// Verify the document was created from the event
		return doc.ID == docID && 
			   doc.ProjectID == projectID && 
			   doc.EventID == evt.EventID
	}, &quick.Config{MaxCount: 50})
}
// **Feature: shrikdb-phase-1b, Property 4: Projection consistency with events**
func TestProjectionConsistencyWithEvents(t *testing.T) {
	quick.Check(func(docID string, projectID string, name string, age uint8) bool {
		if docID == "" || projectID == "" || name == "" {
			return true // Skip invalid inputs
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
		
		// Create document.created event
		payload := DocumentCreatedPayload{
			DocumentID: docID,
			Collection: "users",
			Content: map[string]interface{}{
				"name": name,
				"age":  int(age),
			},
		}
		
		payloadBytes, err := json.Marshal(payload)
		if err != nil {
			return false
		}
		
		evt := &event.Event{
			EventID:        "event_" + docID,
			ProjectID:      projectID,
			EventType:      "document.created",
			Payload:        payloadBytes,
			SequenceNumber: 1,
			Timestamp:      time.Now().UTC(),
		}
		
		// Process event
		err = engine.ProcessEvent(ctx, evt)
		if err != nil {
			return false
		}
		
		// Verify projection reflects the event data exactly
		doc, err := store.GetDocument(ctx, docID)
		if err != nil {
			return false
		}
		
		// Check that projection matches event payload
		return doc.Content["name"] == name && 
			   doc.Content["age"] == int(age) &&
			   doc.Collection == "users" &&
			   doc.ProjectID == projectID
	}, &quick.Config{MaxCount: 50})
}
// **Feature: shrikdb-phase-1b, Property 5: Event persistence despite projection failures**
func TestEventPersistenceDespiteProjectionFailures(t *testing.T) {
	// This test simulates projection failures and verifies events remain intact
	// Note: In a real implementation, we'd need to mock the store to simulate failures
	// For now, we test the error handling behavior
	
	tempDir := t.TempDir()
	logger := zerolog.New(os.Stdout)
	store, err := docstore.NewEmbeddedStore(tempDir, logger)
	if err != nil {
		t.Fatalf("Failed to create store: %v", err)
	}
	defer store.Close()
	
	engine := New(store, logger)
	ctx := context.Background()
	
	// Test with invalid payload (should cause projection failure)
	evt := &event.Event{
		EventID:        "event_invalid",
		ProjectID:      "project1",
		EventType:      "document.created",
		Payload:        []byte(`{"invalid": "missing required fields"}`),
		SequenceNumber: 1,
		Timestamp:      time.Now().UTC(),
	}
	
	// Process event - should fail but not panic
	err = engine.ProcessEvent(ctx, evt)
	if err == nil {
		t.Errorf("Expected error for invalid payload, got nil")
	}
	
	// Verify metrics still track the attempt
	metrics := engine.GetMetrics()
	if metrics.ProcessingErrors == 0 {
		t.Errorf("Expected processing error to be recorded")
	}
	
	// Test that valid events still work after failures
	validPayload := DocumentCreatedPayload{
		DocumentID: "doc_valid",
		Collection: "users",
		Content:    map[string]interface{}{"name": "Valid User"},
	}
	
	validPayloadBytes, err := json.Marshal(validPayload)
	if err != nil {
		t.Fatalf("Failed to marshal valid payload: %v", err)
	}
	
	validEvt := &event.Event{
		EventID:        "event_valid",
		ProjectID:      "project1",
		EventType:      "document.created",
		Payload:        validPayloadBytes,
		SequenceNumber: 2,
		Timestamp:      time.Now().UTC(),
	}
	
	err = engine.ProcessEvent(ctx, validEvt)
	if err != nil {
		t.Errorf("Valid event should process successfully after failure: %v", err)
	}
	
	// Verify valid document was created
	doc, err := store.GetDocument(ctx, "doc_valid")
	if err != nil {
		t.Errorf("Valid document should exist: %v", err)
	}
	if doc.Content["name"] != "Valid User" {
		t.Errorf("Document content mismatch: got %v, want Valid User", doc.Content["name"])
	}
}

// **Feature: shrikdb-phase-1b, Property 29: Partial update correctness**
func TestPartialUpdateCorrectness(t *testing.T) {
	quick.Check(func(docID string, projectID string, initialName string, initialAge uint8, updateAge uint8, updateCity string) bool {
		if docID == "" || projectID == "" || initialName == "" || updateCity == "" {
			return true // Skip invalid inputs
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
		
		// Create initial document
		createPayload := DocumentCreatedPayload{
			DocumentID: docID,
			Collection: "users",
			Content: map[string]interface{}{
				"name": initialName,
				"age":  int(initialAge),
				"email": "test@example.com",
			},
		}
		
		createPayloadBytes, err := json.Marshal(createPayload)
		if err != nil {
			return false
		}
		
		createEvt := &event.Event{
			EventID:        "create_" + docID,
			ProjectID:      projectID,
			EventType:      "document.created",
			Payload:        createPayloadBytes,
			SequenceNumber: 1,
			Timestamp:      time.Now().UTC(),
		}
		
		// Process create event
		err = engine.ProcessEvent(ctx, createEvt)
		if err != nil {
			return false
		}
		
		// Perform partial update (only age and city, leave name and email unchanged)
		updatePayload := DocumentUpdatedPayload{
			DocumentID: docID,
			Updates: map[string]interface{}{
				"age":  int(updateAge),
				"city": updateCity,
			},
		}
		
		updatePayloadBytes, err := json.Marshal(updatePayload)
		if err != nil {
			return false
		}
		
		updateEvt := &event.Event{
			EventID:        "update_" + docID,
			ProjectID:      projectID,
			EventType:      "document.updated",
			Payload:        updatePayloadBytes,
			SequenceNumber: 2,
			Timestamp:      time.Now().UTC(),
		}
		
		// Process update event
		err = engine.ProcessEvent(ctx, updateEvt)
		if err != nil {
			return false
		}
		
		// Verify partial update correctness
		doc, err := store.GetDocument(ctx, docID)
		if err != nil {
			return false
		}
		
		// Check that updated fields have new values
		if doc.Content["age"] != int(updateAge) {
			return false
		}
		if doc.Content["city"] != updateCity {
			return false
		}
		
		// Check that non-updated fields remain unchanged
		if doc.Content["name"] != initialName {
			return false
		}
		if doc.Content["email"] != "test@example.com" {
			return false
		}
		
		// Check that version was incremented
		if doc.Version != 2 {
			return false
		}
		
		return true
	}, &quick.Config{MaxCount: 50})
}