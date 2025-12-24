package wal

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/rs/zerolog"
)

func setupTestWAL(t *testing.T) (*WAL, string) {
	t.Helper()

	tmpDir, err := os.MkdirTemp("", "shrikdb-wal-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}

	logger := zerolog.New(zerolog.NewTestWriter(t)).With().Timestamp().Logger()
	config := DefaultConfig(tmpDir)
	config.SyncMode = "always" // Ensure durability in tests

	w, err := New(config, logger)
	if err != nil {
		os.RemoveAll(tmpDir)
		t.Fatalf("Failed to create WAL: %v", err)
	}

	return w, tmpDir
}

func TestWAL_AppendAndRead(t *testing.T) {
	w, tmpDir := setupTestWAL(t)
	defer os.RemoveAll(tmpDir)
	defer w.Close()

	projectID := "test-project"
	payload := json.RawMessage(`{"user": "alice", "action": "login"}`)

	// Append event
	evt, err := w.Append(projectID, "user.login", payload, nil)
	if err != nil {
		t.Fatalf("Append failed: %v", err)
	}

	if evt.SequenceNumber != 1 {
		t.Errorf("SequenceNumber = %d, want 1", evt.SequenceNumber)
	}

	// Read events
	events, err := w.ReadEvents(projectID, 0)
	if err != nil {
		t.Fatalf("ReadEvents failed: %v", err)
	}

	if len(events) != 1 {
		t.Fatalf("Expected 1 event, got %d", len(events))
	}

	if events[0].EventID != evt.EventID {
		t.Errorf("Event ID mismatch")
	}
}

func TestWAL_SequenceOrdering(t *testing.T) {
	w, tmpDir := setupTestWAL(t)
	defer os.RemoveAll(tmpDir)
	defer w.Close()

	projectID := "test-project"

	// Append multiple events
	for i := 1; i <= 10; i++ {
		payload := json.RawMessage(fmt.Sprintf(`{"index": %d}`, i))
		evt, err := w.Append(projectID, "test.event", payload, nil)
		if err != nil {
			t.Fatalf("Append %d failed: %v", i, err)
		}

		if evt.SequenceNumber != uint64(i) {
			t.Errorf("Event %d: SequenceNumber = %d, want %d", i, evt.SequenceNumber, i)
		}
	}

	// Read and verify ordering
	events, err := w.ReadEvents(projectID, 0)
	if err != nil {
		t.Fatalf("ReadEvents failed: %v", err)
	}

	if len(events) != 10 {
		t.Fatalf("Expected 10 events, got %d", len(events))
	}

	for i, evt := range events {
		expected := uint64(i + 1)
		if evt.SequenceNumber != expected {
			t.Errorf("Event %d: SequenceNumber = %d, want %d", i, evt.SequenceNumber, expected)
		}
	}
}

func TestWAL_ProjectIsolation(t *testing.T) {
	w, tmpDir := setupTestWAL(t)
	defer os.RemoveAll(tmpDir)
	defer w.Close()

	// Append to different projects
	payload := json.RawMessage(`{"data": "test"}`)

	w.Append("project-a", "test", payload, nil)
	w.Append("project-a", "test", payload, nil)
	w.Append("project-b", "test", payload, nil)

	// Read project A
	eventsA, _ := w.ReadEvents("project-a", 0)
	if len(eventsA) != 2 {
		t.Errorf("Project A: expected 2 events, got %d", len(eventsA))
	}

	// Read project B
	eventsB, _ := w.ReadEvents("project-b", 0)
	if len(eventsB) != 1 {
		t.Errorf("Project B: expected 1 event, got %d", len(eventsB))
	}

	// Verify sequence numbers are per-project
	if eventsA[0].SequenceNumber != 1 || eventsA[1].SequenceNumber != 2 {
		t.Error("Project A sequence numbers incorrect")
	}
	if eventsB[0].SequenceNumber != 1 {
		t.Error("Project B sequence number incorrect")
	}
}

func TestWAL_ReadFromOffset(t *testing.T) {
	w, tmpDir := setupTestWAL(t)
	defer os.RemoveAll(tmpDir)
	defer w.Close()

	projectID := "test-project"
	payload := json.RawMessage(`{"data": "test"}`)

	// Append 5 events
	for i := 0; i < 5; i++ {
		w.Append(projectID, "test", payload, nil)
	}

	// Read from offset 3
	events, err := w.ReadEvents(projectID, 3)
	if err != nil {
		t.Fatalf("ReadEvents failed: %v", err)
	}

	if len(events) != 3 {
		t.Fatalf("Expected 3 events (seq 3,4,5), got %d", len(events))
	}

	if events[0].SequenceNumber != 3 {
		t.Errorf("First event sequence = %d, want 3", events[0].SequenceNumber)
	}
}

func TestWAL_CrashRecovery(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "shrikdb-wal-crash-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	logger := zerolog.New(zerolog.NewTestWriter(t)).With().Timestamp().Logger()
	config := DefaultConfig(tmpDir)

	projectID := "test-project"
	payload := json.RawMessage(`{"data": "test"}`)

	// First WAL instance - write some events
	w1, err := New(config, logger)
	if err != nil {
		t.Fatalf("Failed to create WAL: %v", err)
	}

	for i := 0; i < 5; i++ {
		w1.Append(projectID, "test", payload, nil)
	}
	w1.Close()

	// Second WAL instance - simulate restart
	w2, err := New(config, logger)
	if err != nil {
		t.Fatalf("Failed to create WAL after restart: %v", err)
	}
	defer w2.Close()

	// Verify events survived
	events, err := w2.ReadEvents(projectID, 0)
	if err != nil {
		t.Fatalf("ReadEvents after restart failed: %v", err)
	}

	if len(events) != 5 {
		t.Errorf("Expected 5 events after restart, got %d", len(events))
	}

	// Append more events - sequence should continue
	evt, err := w2.Append(projectID, "test", payload, nil)
	if err != nil {
		t.Fatalf("Append after restart failed: %v", err)
	}

	if evt.SequenceNumber != 6 {
		t.Errorf("Sequence after restart = %d, want 6", evt.SequenceNumber)
	}
}

func TestWAL_ChainIntegrity(t *testing.T) {
	w, tmpDir := setupTestWAL(t)
	defer os.RemoveAll(tmpDir)
	defer w.Close()

	projectID := "test-project"
	payload := json.RawMessage(`{"data": "test"}`)

	// Append events
	var lastHash string
	for i := 0; i < 5; i++ {
		evt, err := w.Append(projectID, "test", payload, nil)
		if err != nil {
			t.Fatalf("Append failed: %v", err)
		}

		// Verify chain
		if i > 0 && evt.PreviousHash != lastHash {
			t.Errorf("Event %d: PreviousHash mismatch", i)
		}

		lastHash = evt.ComputeEventHash()
	}

	// Read and verify chain
	events, _ := w.ReadEvents(projectID, 0)
	for i := 1; i < len(events); i++ {
		expectedPrev := events[i-1].ComputeEventHash()
		if events[i].PreviousHash != expectedPrev {
			t.Errorf("Event %d: chain broken", i)
		}
	}
}

func TestWAL_FileLayout(t *testing.T) {
	w, tmpDir := setupTestWAL(t)
	defer os.RemoveAll(tmpDir)
	defer w.Close()

	projectID := "test-project"
	payload := json.RawMessage(`{"data": "test"}`)

	w.Append(projectID, "test", payload, nil)

	// Verify file structure
	projectDir := filepath.Join(tmpDir, "projects", projectID)
	walFile := filepath.Join(projectDir, "events.wal")

	if _, err := os.Stat(projectDir); os.IsNotExist(err) {
		t.Error("Project directory not created")
	}

	if _, err := os.Stat(walFile); os.IsNotExist(err) {
		t.Error("WAL file not created")
	}

	// Verify file is human-readable (JSON lines)
	content, err := os.ReadFile(walFile)
	if err != nil {
		t.Fatalf("Failed to read WAL file: %v", err)
	}

	// Should be valid JSON
	var evt map[string]interface{}
	if err := json.Unmarshal(content[:len(content)-1], &evt); err != nil { // -1 for newline
		t.Errorf("WAL content is not valid JSON: %v", err)
	}
}

func TestWAL_Metrics(t *testing.T) {
	w, tmpDir := setupTestWAL(t)
	defer os.RemoveAll(tmpDir)
	defer w.Close()

	projectID := "test-project"
	payload := json.RawMessage(`{"data": "test"}`)

	// Append events
	for i := 0; i < 10; i++ {
		w.Append(projectID, "test", payload, nil)
	}

	metrics := w.GetMetrics()

	if metrics.EventsAppended != 10 {
		t.Errorf("EventsAppended = %d, want 10", metrics.EventsAppended)
	}

	if metrics.BytesWritten == 0 {
		t.Error("BytesWritten should be > 0")
	}

	if metrics.SyncsPerformed == 0 {
		t.Error("SyncsPerformed should be > 0 in 'always' mode")
	}
}

func TestWAL_EmptyProject(t *testing.T) {
	w, tmpDir := setupTestWAL(t)
	defer os.RemoveAll(tmpDir)
	defer w.Close()

	// Read from non-existent project
	events, err := w.ReadEvents("nonexistent", 0)
	if err != nil {
		t.Fatalf("ReadEvents failed: %v", err)
	}

	if len(events) != 0 {
		t.Errorf("Expected 0 events for non-existent project, got %d", len(events))
	}
}
// **Feature: shrikdb-phase-1a, Property 1: Event Durability Before Response**
// **Validates: Requirements 1.1, 3.4, 3.5**
func TestProperty_EventDurabilityBeforeResponse(t *testing.T) {
	// Test event durability with concrete scenarios
	testCases := []struct {
		projectID string
		eventType string
		payload   map[string]interface{}
	}{
		{"test-proj-1", "user.login", map[string]interface{}{"user": "alice", "action": "login"}},
		{"test-proj-2", "user.logout", map[string]interface{}{"user": "bob", "action": "logout"}},
		{"test-proj-3", "data.update", map[string]interface{}{"table": "users", "id": 123}},
		{"test-proj-4", "system.event", map[string]interface{}{"type": "startup", "version": "1.0"}},
	}
	
	for _, tc := range testCases {
		t.Run(fmt.Sprintf("project_%s_type_%s", tc.projectID, tc.eventType), func(t *testing.T) {
			w, tmpDir := setupTestWAL(t)
			defer os.RemoveAll(tmpDir)
			defer w.Close()
			
			payload, err := json.Marshal(tc.payload)
			if err != nil {
				t.Fatalf("Failed to marshal payload: %v", err)
			}
			
			// Append event - this should only return after fsync
			evt, err := w.Append(tc.projectID, tc.eventType, payload, nil)
			if err != nil {
				t.Fatalf("Failed to append event: %v", err)
			}
			
			// Immediately try to read the event - it should be there
			events, err := w.ReadEvents(tc.projectID, 0)
			if err != nil {
				t.Fatalf("Failed to read events: %v", err)
			}
			
			// Event should be persisted and readable
			if len(events) != 1 {
				t.Errorf("Expected 1 event, got %d", len(events))
			}
			
			if len(events) > 0 && events[0].EventID != evt.EventID {
				t.Errorf("Event ID mismatch: expected %s, got %s", evt.EventID, events[0].EventID)
			}
		})
	}
}

// **Feature: shrikdb-phase-1a, Property 2: Event Immutability and Ordering**
// **Validates: Requirements 1.2, 1.4**
func TestProperty_EventImmutabilityAndOrdering(t *testing.T) {
	// Test event immutability and ordering with concrete scenarios
	testCases := []struct {
		projectID  string
		eventType  string
		numEvents  int
	}{
		{"test-proj-1", "user.login", 1},
		{"test-proj-2", "user.logout", 3},
		{"test-proj-3", "data.update", 5},
		{"test-proj-4", "system.event", 10},
	}
	
	for _, tc := range testCases {
		t.Run(fmt.Sprintf("project_%s_events_%d", tc.projectID, tc.numEvents), func(t *testing.T) {
			w, tmpDir := setupTestWAL(t)
			defer os.RemoveAll(tmpDir)
			defer w.Close()
			
			var appendedEvents []string
			
			// Append multiple events
			for i := 0; i < tc.numEvents; i++ {
				payload, _ := json.Marshal(map[string]interface{}{
					"index": i,
					"data":  fmt.Sprintf("event-%d", i),
				})
				
				evt, err := w.Append(tc.projectID, tc.eventType, payload, nil)
				if err != nil {
					t.Fatalf("Failed to append event %d: %v", i, err)
				}
				
				appendedEvents = append(appendedEvents, evt.EventID)
			}
			
			// Read events back
			events, err := w.ReadEvents(tc.projectID, 0)
			if err != nil {
				t.Fatalf("Failed to read events: %v", err)
			}
			
			// Verify ordering (sequence numbers should be strictly increasing)
			for i := 1; i < len(events); i++ {
				if events[i].SequenceNumber != events[i-1].SequenceNumber+1 {
					t.Errorf("Event %d: sequence number %d, expected %d", i, events[i].SequenceNumber, events[i-1].SequenceNumber+1)
				}
			}
			
			// Verify immutability (events should match what we appended)
			if len(events) != len(appendedEvents) {
				t.Errorf("Expected %d events, got %d", len(appendedEvents), len(events))
			}
			
			for i, evt := range events {
				if i < len(appendedEvents) && evt.EventID != appendedEvents[i] {
					t.Errorf("Event %d ID mismatch: expected %s, got %s", i, appendedEvents[i], evt.EventID)
				}
			}
		})
	}
}

// **Feature: shrikdb-phase-1a, Property 8: Crash Recovery and Resilience**
// **Validates: Requirements 5.2, 5.3, 5.4, 5.5**
func TestProperty_CrashRecoveryAndResilience(t *testing.T) {
	// Test crash recovery with a few concrete scenarios
	testCases := []struct {
		projectID  string
		eventType  string
		numEvents  int
	}{
		{"test-proj-1", "user.login", 1},
		{"test-proj-2", "user.logout", 2},
		{"test-proj-3", "data.update", 3},
		{"test-proj-4", "system.event", 5},
	}
	
	for _, tc := range testCases {
		t.Run(fmt.Sprintf("project_%s_events_%d", tc.projectID, tc.numEvents), func(t *testing.T) {
			tmpDir, err := os.MkdirTemp("", "shrikdb-crash-test-*")
			if err != nil {
				t.Fatalf("Failed to create temp dir: %v", err)
			}
			defer os.RemoveAll(tmpDir)
			
			logger := zerolog.New(zerolog.NewTestWriter(t)).With().Timestamp().Logger()
			config := DefaultConfig(tmpDir)
			config.SyncMode = "always" // Ensure durability
			
			var originalEvents []string
			
			// First WAL instance - write events
			{
				w1, err := New(config, logger)
				if err != nil {
					t.Fatalf("Failed to create WAL: %v", err)
				}
				
				for i := 0; i < tc.numEvents; i++ {
					payload, _ := json.Marshal(map[string]interface{}{
						"index": i,
						"data":  fmt.Sprintf("event-%d", i),
					})
					
					evt, err := w1.Append(tc.projectID, tc.eventType, payload, nil)
					if err != nil {
						t.Fatalf("Failed to append event %d: %v", i, err)
					}
					
					originalEvents = append(originalEvents, evt.EventID)
				}
				
				w1.Close() // Simulate crash/restart
			}
			
			// Second WAL instance - simulate restart and recovery
			{
				w2, err := New(config, logger)
				if err != nil {
					t.Fatalf("Failed to create WAL after restart: %v", err)
				}
				defer w2.Close()
				
				// Read events after recovery
				events, err := w2.ReadEvents(tc.projectID, 0)
				if err != nil {
					t.Fatalf("Failed to read events after recovery: %v", err)
				}
				
				// Verify all events survived the crash
				if len(events) != len(originalEvents) {
					t.Errorf("Expected %d events after recovery, got %d", len(originalEvents), len(events))
				}
				
				for i, evt := range events {
					if i < len(originalEvents) && evt.EventID != originalEvents[i] {
						t.Errorf("Event %d ID mismatch: expected %s, got %s", i, originalEvents[i], evt.EventID)
					}
				}
				
				// Verify sequence numbers are correct after recovery
				lastSeq, err := w2.GetProjectSequence(tc.projectID)
				if err != nil {
					t.Fatalf("Failed to get project sequence: %v", err)
				}
				
				if lastSeq != uint64(len(originalEvents)) {
					t.Errorf("Expected sequence %d after recovery, got %d", len(originalEvents), lastSeq)
				}
				
				// Append new event - sequence should continue correctly
				newPayload, _ := json.Marshal(map[string]interface{}{"recovery": "test"})
				newEvt, err := w2.Append(tc.projectID, tc.eventType, newPayload, nil)
				if err != nil {
					t.Fatalf("Failed to append event after recovery: %v", err)
				}
				
				if newEvt.SequenceNumber != lastSeq+1 {
					t.Errorf("Expected sequence %d for new event, got %d", lastSeq+1, newEvt.SequenceNumber)
				}
			}
		})
	}
}
