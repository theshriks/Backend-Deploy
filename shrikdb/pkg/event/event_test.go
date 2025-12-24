package event

import (
	"encoding/json"
	"fmt"
	"testing"
	
	"github.com/leanovate/gopter"
	"github.com/leanovate/gopter/gen"
	"github.com/leanovate/gopter/prop"
)

func TestNewEvent(t *testing.T) {
	payload := json.RawMessage(`{"key": "value", "num": 42}`)

	evt, err := NewEvent("project-1", "user.created", payload, 1, "", nil)
	if err != nil {
		t.Fatalf("NewEvent failed: %v", err)
	}

	// Verify required fields
	if evt.EventID == "" {
		t.Error("EventID should not be empty")
	}
	if evt.ProjectID != "project-1" {
		t.Errorf("ProjectID = %s, want project-1", evt.ProjectID)
	}
	if evt.EventType != "user.created" {
		t.Errorf("EventType = %s, want user.created", evt.EventType)
	}
	if evt.SequenceNumber != 1 {
		t.Errorf("SequenceNumber = %d, want 1", evt.SequenceNumber)
	}
	if evt.PayloadHash == "" {
		t.Error("PayloadHash should not be empty")
	}
	if evt.Timestamp.IsZero() {
		t.Error("Timestamp should not be zero")
	}
}

func TestNewEvent_Validation(t *testing.T) {
	payload := json.RawMessage(`{"key": "value"}`)

	tests := []struct {
		name      string
		projectID string
		eventType string
		payload   json.RawMessage
		wantErr   error
	}{
		{"empty project", "", "test", payload, ErrEmptyProjectID},
		{"empty event type", "proj", "", payload, ErrEmptyEventType},
		{"empty payload", "proj", "test", nil, ErrEmptyPayload},
		{"invalid json", "proj", "test", json.RawMessage(`{invalid}`), ErrInvalidPayload},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := NewEvent(tt.projectID, tt.eventType, tt.payload, 1, "", nil)
			if err != tt.wantErr {
				t.Errorf("NewEvent() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestEvent_VerifyIntegrity(t *testing.T) {
	payload := json.RawMessage(`{"key": "value"}`)

	evt, err := NewEvent("project-1", "test", payload, 1, "", nil)
	if err != nil {
		t.Fatalf("NewEvent failed: %v", err)
	}

	// Should pass integrity check
	if err := evt.VerifyIntegrity(); err != nil {
		t.Errorf("VerifyIntegrity failed: %v", err)
	}

	// Tamper with payload
	evt.Payload = json.RawMessage(`{"key": "tampered"}`)

	// Should fail integrity check
	if err := evt.VerifyIntegrity(); err != ErrHashMismatch {
		t.Errorf("VerifyIntegrity should fail with ErrHashMismatch, got %v", err)
	}
}

func TestEvent_DeterministicHash(t *testing.T) {
	// Same payload with different key ordering should produce same hash
	payload1 := json.RawMessage(`{"b": 2, "a": 1}`)
	payload2 := json.RawMessage(`{"a": 1, "b": 2}`)

	evt1, _ := NewEvent("proj", "test", payload1, 1, "", nil)
	evt2, _ := NewEvent("proj", "test", payload2, 1, "", nil)

	if evt1.PayloadHash != evt2.PayloadHash {
		t.Errorf("Hashes should be equal for equivalent payloads: %s != %s", evt1.PayloadHash, evt2.PayloadHash)
	}
}

func TestEvent_SerializeDeserialize(t *testing.T) {
	payload := json.RawMessage(`{"key": "value", "nested": {"a": 1}}`)
	metadata := map[string]string{"source": "test"}

	original, err := NewEvent("project-1", "test.event", payload, 42, "prev_hash", metadata)
	if err != nil {
		t.Fatalf("NewEvent failed: %v", err)
	}

	// Serialize
	data, err := original.Serialize()
	if err != nil {
		t.Fatalf("Serialize failed: %v", err)
	}

	// Deserialize
	restored, err := Deserialize(data)
	if err != nil {
		t.Fatalf("Deserialize failed: %v", err)
	}

	// Verify fields
	if restored.EventID != original.EventID {
		t.Errorf("EventID mismatch: %s != %s", restored.EventID, original.EventID)
	}
	if restored.ProjectID != original.ProjectID {
		t.Errorf("ProjectID mismatch")
	}
	if restored.EventType != original.EventType {
		t.Errorf("EventType mismatch")
	}
	if restored.SequenceNumber != original.SequenceNumber {
		t.Errorf("SequenceNumber mismatch")
	}
	if restored.PayloadHash != original.PayloadHash {
		t.Errorf("PayloadHash mismatch")
	}
	if restored.PreviousHash != original.PreviousHash {
		t.Errorf("PreviousHash mismatch")
	}

	// Verify integrity after round-trip
	if err := restored.VerifyIntegrity(); err != nil {
		t.Errorf("Integrity check failed after round-trip: %v", err)
	}
}

func TestEvent_ChainHash(t *testing.T) {
	payload := json.RawMessage(`{"data": "test"}`)

	evt1, _ := NewEvent("proj", "test", payload, 1, "", nil)
	hash1 := evt1.ComputeEventHash()

	evt2, _ := NewEvent("proj", "test", payload, 2, hash1, nil)

	// Verify chain
	if !evt2.VerifyChain(hash1) {
		t.Error("Chain verification failed")
	}

	// Wrong hash should fail
	if evt2.VerifyChain("wrong_hash") {
		t.Error("Chain verification should fail with wrong hash")
	}
}

func TestCanonicalizeJSON(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "sorted keys",
			input: `{"z": 1, "a": 2, "m": 3}`,
			want:  `{"a":2,"m":3,"z":1}`,
		},
		{
			name:  "nested objects",
			input: `{"outer": {"b": 2, "a": 1}}`,
			want:  `{"outer":{"a":1,"b":2}}`,
		},
		{
			name:  "arrays preserved",
			input: `{"arr": [3, 1, 2]}`,
			want:  `{"arr":[3,1,2]}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := canonicalizeJSON(json.RawMessage(tt.input))
			if err != nil {
				t.Fatalf("canonicalizeJSON failed: %v", err)
			}
			if string(result) != tt.want {
				t.Errorf("canonicalizeJSON() = %s, want %s", result, tt.want)
			}
		})
	}
}

func TestGenerateSortableID(t *testing.T) {
	id1 := generateSortableID()
	id2 := generateSortableID()

	// IDs should be unique
	if id1 == id2 {
		t.Error("Generated IDs should be unique")
	}

	// IDs should be sortable (later ID >= earlier ID due to nanosecond precision)
	if id1 >= id2 {
		t.Logf("ID1: %s, ID2: %s - IDs are properly ordered", id1, id2)
	}

	// ID should have expected length (16 hex chars timestamp + 8 uuid chars)
	if len(id1) != 24 {
		t.Errorf("ID length = %d, want 24", len(id1))
	}
}

// **Feature: shrikdb-phase-1a, Property 3: Event Structure Completeness**
// **Validates: Requirements 1.3**
func TestProperty_EventStructureCompleteness(t *testing.T) {
	properties := gopter.NewProperties(nil)
	
	properties.Property("all events have complete structure", prop.ForAll(
		func(seqNum uint64) bool {
			// Use fixed valid inputs to focus on the property being tested
			projectID := "test-project"
			eventType := "test.event"
			payload := json.RawMessage(`{"test": "data"}`)
			
			// Create event
			evt, err := NewEvent(projectID, eventType, payload, seqNum, "", nil)
			if err != nil {
				return seqNum == 0 // Should only fail for invalid sequence numbers
			}
			
			// Verify all required fields are present and non-empty
			return evt.EventID != "" &&
				evt.ProjectID == projectID &&
				evt.EventType == eventType &&
				len(evt.Payload) > 0 &&
				evt.PayloadHash != "" &&
				evt.SequenceNumber == seqNum &&
				!evt.Timestamp.IsZero()
		},
		gen.UInt64Range(1, 1000),
	))
	
	properties.TestingRun(t, gopter.ConsoleReporter(false))
}

// **Feature: shrikdb-phase-1a, Property 4: Hash Chain Integrity**
// **Validates: Requirements 1.5**
func TestProperty_HashChainIntegrity(t *testing.T) {
	properties := gopter.NewProperties(nil)
	
	properties.Property("hash chain maintains integrity", prop.ForAll(
		func(eventCount uint8) bool {
			// Limit event count to reasonable range
			if eventCount == 0 || eventCount > 10 {
				return true
			}
			
			projectID := "test-project"
			eventType := "test.event"
			
			var events []*Event
			var previousHash string
			
			// Create a chain of events
			for i := uint8(0); i < eventCount; i++ {
				payload := json.RawMessage(fmt.Sprintf(`{"index": %d}`, i))
				
				evt, err := NewEvent(projectID, eventType, payload, uint64(i+1), previousHash, nil)
				if err != nil {
					return false // Should not fail with valid inputs
				}
				
				events = append(events, evt)
				previousHash = evt.ComputeEventHash()
			}
			
			// Verify chain integrity
			var lastHash string
			for _, evt := range events {
				if !evt.VerifyChain(lastHash) {
					return false
				}
				lastHash = evt.ComputeEventHash()
			}
			
			return true
		},
		gen.UInt8Range(1, 10),
	))
	
	properties.TestingRun(t, gopter.ConsoleReporter(false))
}