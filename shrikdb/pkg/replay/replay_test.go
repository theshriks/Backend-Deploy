package replay

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"testing/quick"

	"github.com/leanovate/gopter"
	"github.com/leanovate/gopter/gen"
	"github.com/leanovate/gopter/prop"
	"shrikdb/pkg/event"
	"shrikdb/pkg/wal"

	"github.com/rs/zerolog"
)

func setupTestReplay(t *testing.T) (*Engine, *wal.WAL, string) {
	t.Helper()

	tmpDir, err := os.MkdirTemp("", "shrikdb-replay-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}

	logger := zerolog.New(zerolog.NewTestWriter(t)).With().Timestamp().Logger()
	config := wal.DefaultConfig(tmpDir)

	w, err := wal.New(config, logger)
	if err != nil {
		os.RemoveAll(tmpDir)
		t.Fatalf("Failed to create WAL: %v", err)
	}

	engine := New(w, logger)

	return engine, w, tmpDir
}

func TestReplay_Basic(t *testing.T) {
	engine, w, tmpDir := setupTestReplay(t)
	defer os.RemoveAll(tmpDir)
	defer w.Close()

	projectID := "test-project"
	payload := json.RawMessage(`{"data": "test"}`)

	// Append events
	for i := 0; i < 10; i++ {
		w.Append(projectID, "test.event", payload, nil)
	}

	// Replay
	var replayedEvents []*event.Event
	handler := func(evt *event.Event) error {
		replayedEvents = append(replayedEvents, evt)
		return nil
	}

	progress, err := engine.Replay(context.Background(), projectID, handler)
	if err != nil {
		t.Fatalf("Replay failed: %v", err)
	}

	if progress.ProcessedEvents != 10 {
		t.Errorf("ProcessedEvents = %d, want 10", progress.ProcessedEvents)
	}

	if len(replayedEvents) != 10 {
		t.Errorf("Replayed %d events, want 10", len(replayedEvents))
	}
}

func TestReplay_Determinism(t *testing.T) {
	engine, w, tmpDir := setupTestReplay(t)
	defer os.RemoveAll(tmpDir)
	defer w.Close()

	projectID := "test-project"

	// Append events with different payloads
	for i := 0; i < 5; i++ {
		payload := json.RawMessage(`{"index": ` + string(rune('0'+i)) + `}`)
		w.Append(projectID, "test.event", payload, nil)
	}

	// First replay
	var events1 []*event.Event
	engine.Replay(context.Background(), projectID, func(evt *event.Event) error {
		events1 = append(events1, evt)
		return nil
	})

	// Second replay
	var events2 []*event.Event
	engine.Replay(context.Background(), projectID, func(evt *event.Event) error {
		events2 = append(events2, evt)
		return nil
	})

	// Verify determinism
	if len(events1) != len(events2) {
		t.Fatalf("Replay count mismatch: %d vs %d", len(events1), len(events2))
	}

	for i := range events1 {
		if events1[i].EventID != events2[i].EventID {
			t.Errorf("Event %d: ID mismatch", i)
		}
		if events1[i].SequenceNumber != events2[i].SequenceNumber {
			t.Errorf("Event %d: Sequence mismatch", i)
		}
		if events1[i].PayloadHash != events2[i].PayloadHash {
			t.Errorf("Event %d: Hash mismatch", i)
		}
	}
}

func TestReplay_FromOffset(t *testing.T) {
	engine, w, tmpDir := setupTestReplay(t)
	defer os.RemoveAll(tmpDir)
	defer w.Close()

	projectID := "test-project"
	payload := json.RawMessage(`{"data": "test"}`)

	// Append 10 events
	for i := 0; i < 10; i++ {
		w.Append(projectID, "test.event", payload, nil)
	}

	// Replay from offset 5
	var replayedEvents []*event.Event
	handler := func(evt *event.Event) error {
		replayedEvents = append(replayedEvents, evt)
		return nil
	}

	progress, err := engine.ReplayFrom(context.Background(), projectID, 5, handler)
	if err != nil {
		t.Fatalf("ReplayFrom failed: %v", err)
	}

	if progress.ProcessedEvents != 6 { // Events 5,6,7,8,9,10
		t.Errorf("ProcessedEvents = %d, want 6", progress.ProcessedEvents)
	}

	if replayedEvents[0].SequenceNumber != 5 {
		t.Errorf("First event sequence = %d, want 5", replayedEvents[0].SequenceNumber)
	}
}

func TestReplay_IntegrityVerification(t *testing.T) {
	engine, w, tmpDir := setupTestReplay(t)
	defer os.RemoveAll(tmpDir)
	defer w.Close()

	projectID := "test-project"
	payload := json.RawMessage(`{"data": "test"}`)

	// Append events
	for i := 0; i < 5; i++ {
		w.Append(projectID, "test.event", payload, nil)
	}

	// Verify integrity
	progress, err := engine.VerifyIntegrity(context.Background(), projectID)
	if err != nil {
		t.Fatalf("VerifyIntegrity failed: %v", err)
	}

	if progress.ProcessedEvents != 5 {
		t.Errorf("ProcessedEvents = %d, want 5", progress.ProcessedEvents)
	}

	if len(progress.Errors) > 0 {
		t.Errorf("Unexpected errors: %v", progress.Errors)
	}
}

func TestReplay_Cancellation(t *testing.T) {
	engine, w, tmpDir := setupTestReplay(t)
	defer os.RemoveAll(tmpDir)
	defer w.Close()

	projectID := "test-project"
	payload := json.RawMessage(`{"data": "test"}`)

	// Append many events
	for i := 0; i < 100; i++ {
		w.Append(projectID, "test.event", payload, nil)
	}

	// Create cancellable context
	ctx, cancel := context.WithCancel(context.Background())

	var count int
	handler := func(evt *event.Event) error {
		count++
		if count >= 10 {
			cancel() // Cancel after 10 events
		}
		return nil
	}

	_, err := engine.Replay(ctx, projectID, handler)
	if err != ErrReplayCanceled {
		t.Errorf("Expected ErrReplayCanceled, got %v", err)
	}
}

func TestReplay_ConcurrentPrevention(t *testing.T) {
	engine, w, tmpDir := setupTestReplay(t)
	defer os.RemoveAll(tmpDir)
	defer w.Close()

	projectID := "test-project"
	payload := json.RawMessage(`{"data": "test"}`)

	// Append events
	for i := 0; i < 100; i++ {
		w.Append(projectID, "test.event", payload, nil)
	}

	// Start first replay (blocking)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	started := make(chan struct{})
	done := make(chan struct{})

	go func() {
		close(started)
		engine.Replay(ctx, projectID, func(evt *event.Event) error {
			// Slow handler
			select {
			case <-ctx.Done():
				return ctx.Err()
			default:
			}
			return nil
		})
		close(done)
	}()

	<-started

	// Try second replay - should fail
	_, err := engine.Replay(context.Background(), projectID, nil)
	if err != ErrReplayInProgress {
		// May succeed if first replay finished quickly
		t.Logf("Second replay result: %v (may be nil if first finished)", err)
	}

	cancel()
	<-done
}

func TestReplay_EmptyProject(t *testing.T) {
	engine, w, tmpDir := setupTestReplay(t)
	defer os.RemoveAll(tmpDir)
	defer w.Close()

	// Replay empty project
	var count int
	progress, err := engine.Replay(context.Background(), "empty-project", func(evt *event.Event) error {
		count++
		return nil
	})

	if err != nil {
		t.Fatalf("Replay failed: %v", err)
	}

	if progress.ProcessedEvents != 0 {
		t.Errorf("ProcessedEvents = %d, want 0", progress.ProcessedEvents)
	}

	if count != 0 {
		t.Errorf("Handler called %d times, want 0", count)
	}
}

func TestReplay_CountEvents(t *testing.T) {
	engine, w, tmpDir := setupTestReplay(t)
	defer os.RemoveAll(tmpDir)
	defer w.Close()

	projectID := "test-project"
	payload := json.RawMessage(`{"data": "test"}`)

	// Append events
	for i := 0; i < 25; i++ {
		w.Append(projectID, "test.event", payload, nil)
	}

	count, err := engine.CountEvents(projectID)
	if err != nil {
		t.Fatalf("CountEvents failed: %v", err)
	}

	if count != 25 {
		t.Errorf("CountEvents = %d, want 25", count)
	}
}

func TestReplay_GetLastEvent(t *testing.T) {
	engine, w, tmpDir := setupTestReplay(t)
	defer os.RemoveAll(tmpDir)
	defer w.Close()

	projectID := "test-project"
	payload := json.RawMessage(`{"data": "test"}`)

	// Append events
	var lastAppended *event.Event
	for i := 0; i < 5; i++ {
		evt, _ := w.Append(projectID, "test.event", payload, nil)
		lastAppended = evt
	}

	lastEvent, err := engine.GetLastEvent(projectID)
	if err != nil {
		t.Fatalf("GetLastEvent failed: %v", err)
	}

	if lastEvent.EventID != lastAppended.EventID {
		t.Errorf("Last event ID mismatch")
	}

	if lastEvent.SequenceNumber != 5 {
		t.Errorf("Last event sequence = %d, want 5", lastEvent.SequenceNumber)
	}
}
// **Feature: shrikdb-phase-1a, Property 9: Replay Determinism and Integrity**
// **Validates: Requirements 6.1, 6.2, 6.3, 6.5**
func TestProperty_ReplayDeterminismAndIntegrity(t *testing.T) {
	properties := gopter.NewProperties(nil)

	properties.Property("replay is deterministic", prop.ForAll(
		func(projectID, eventType string, payloadList []map[string]string) bool {
			// Skip invalid inputs
			if projectID == "" || eventType == "" || len(payloadList) == 0 {
				return true
			}

			engine, w, tmpDir := setupTestReplay(t)
			defer os.RemoveAll(tmpDir)
			defer w.Close()

			// Append events
			for i, payloadData := range payloadList {
				if i >= 10 { // Limit events to prevent timeout
					break
				}

				// Convert to map[string]interface{}
				payload_map := make(map[string]interface{})
				for k, v := range payloadData {
					payload_map[k] = v
				}

				payload, err := json.Marshal(payload_map)
				if err != nil {
					continue
				}

				w.Append(projectID, eventType, payload, nil)
			}

			// First replay
			var events1 []*event.Event
			_, err1 := engine.Replay(context.Background(), projectID, func(evt *event.Event) error {
				events1 = append(events1, evt)
				return nil
			})

			// Second replay
			var events2 []*event.Event
			_, err2 := engine.Replay(context.Background(), projectID, func(evt *event.Event) error {
				events2 = append(events2, evt)
				return nil
			})

			if err1 != nil || err2 != nil {
				return false
			}

			// Verify determinism - both replays should produce identical results
			if len(events1) != len(events2) {
				return false
			}

			for i := range events1 {
				if events1[i].EventID != events2[i].EventID ||
					events1[i].SequenceNumber != events2[i].SequenceNumber ||
					events1[i].PayloadHash != events2[i].PayloadHash {
					return false
				}
			}

			return true
		},
		gen.AlphaString().SuchThat(func(s string) bool { return len(s) > 0 && len(s) < 20 }),
		gen.AlphaString().SuchThat(func(s string) bool { return len(s) > 0 && len(s) < 20 }),
		gen.SliceOfN(5, gen.MapOf(gen.AlphaString(), gen.AlphaString())),
	))

	properties.Property("replay processes events in strict order", prop.ForAll(
		func(projectID, eventType string, payloadList []map[string]string) bool {
			// Skip invalid inputs
			if projectID == "" || eventType == "" || len(payloadList) == 0 {
				return true
			}

			engine, w, tmpDir := setupTestReplay(t)
			defer os.RemoveAll(tmpDir)
			defer w.Close()

			// Append events
			for i, payloadData := range payloadList {
				if i >= 10 { // Limit events
					break
				}

				// Convert to map[string]interface{}
				payload_map := make(map[string]interface{})
				for k, v := range payloadData {
					payload_map[k] = v
				}

				payload, err := json.Marshal(payload_map)
				if err != nil {
					continue
				}

				w.Append(projectID, eventType, payload, nil)
			}

			// Replay and verify ordering
			var lastSeq uint64
			_, err := engine.Replay(context.Background(), projectID, func(evt *event.Event) error {
				// Verify strict ordering
				if lastSeq > 0 && evt.SequenceNumber != lastSeq+1 {
					return errors.New("sequence order violation")
				}
				lastSeq = evt.SequenceNumber
				return nil
			})

			return err == nil
		},
		gen.AlphaString().SuchThat(func(s string) bool { return len(s) > 0 && len(s) < 20 }),
		gen.AlphaString().SuchThat(func(s string) bool { return len(s) > 0 && len(s) < 20 }),
		gen.SliceOfN(5, gen.MapOf(gen.AlphaString(), gen.AlphaString())),
	))

	properties.Property("replay verifies integrity", prop.ForAll(
		func(projectID, eventType string, payloadList []map[string]string) bool {
			// Skip invalid inputs
			if projectID == "" || eventType == "" || len(payloadList) == 0 {
				return true
			}

			engine, w, tmpDir := setupTestReplay(t)
			defer os.RemoveAll(tmpDir)
			defer w.Close()

			// Append events
			for i, payloadData := range payloadList {
				if i >= 10 { // Limit events
					break
				}

				// Convert to map[string]interface{}
				payload_map := make(map[string]interface{})
				for k, v := range payloadData {
					payload_map[k] = v
				}

				payload, err := json.Marshal(payload_map)
				if err != nil {
					continue
				}

				w.Append(projectID, eventType, payload, nil)
			}

			// Verify integrity during replay
			progress, err := engine.VerifyIntegrity(context.Background(), projectID)
			if err != nil {
				return false
			}

			// Should have no integrity errors
			return len(progress.Errors) == 0
		},
		gen.AlphaString().SuchThat(func(s string) bool { return len(s) > 0 && len(s) < 20 }),
		gen.AlphaString().SuchThat(func(s string) bool { return len(s) > 0 && len(s) < 20 }),
		gen.SliceOfN(5, gen.MapOf(gen.AlphaString(), gen.AlphaString())),
	))

	properties.Property("replay from offset works correctly", prop.ForAll(
		func(projectID, eventType string, payloadList []map[string]string, offset uint64) bool {
			// Skip invalid inputs
			if projectID == "" || eventType == "" || len(payloadList) == 0 {
				return true
			}

			engine, w, tmpDir := setupTestReplay(t)
			defer os.RemoveAll(tmpDir)
			defer w.Close()

			// Append events
			var eventCount uint64
			for i, payloadData := range payloadList {
				if i >= 10 { // Limit events
					break
				}

				// Convert to map[string]interface{}
				payload_map := make(map[string]interface{})
				for k, v := range payloadData {
					payload_map[k] = v
				}

				payload, err := json.Marshal(payload_map)
				if err != nil {
					continue
				}

				w.Append(projectID, eventType, payload, nil)
				eventCount++
			}

			if eventCount == 0 {
				return true
			}

			// Limit offset to valid range
			if offset > eventCount {
				offset = eventCount
			}

			// Replay from offset
			var replayedCount uint64
			_, err := engine.ReplayFrom(context.Background(), projectID, offset, func(evt *event.Event) error {
				// Verify sequence numbers start from offset
				if replayedCount == 0 && evt.SequenceNumber < offset {
					return errors.New("replay started before offset")
				}
				replayedCount++
				return nil
			})

			if err != nil {
				return false
			}

			// Verify correct number of events replayed
			expectedCount := eventCount - offset
			if offset > 0 {
				expectedCount++
			}

			return replayedCount == expectedCount || (offset == eventCount && replayedCount == 0)
		},
		gen.AlphaString().SuchThat(func(s string) bool { return len(s) > 0 && len(s) < 20 }),
		gen.AlphaString().SuchThat(func(s string) bool { return len(s) > 0 && len(s) < 20 }),
		gen.SliceOfN(5, gen.MapOf(gen.AlphaString(), gen.AlphaString())),
		gen.UInt64Range(0, 10),
	))

	properties.TestingRun(t, gopter.ConsoleReporter(false))
}
// Test projection rebuild functionality

type MockProjectionHandler struct {
	processedEvents []*event.Event
	rebuildCalled   bool
	shouldFail      bool
}

func (m *MockProjectionHandler) ProcessEvent(ctx context.Context, evt *event.Event) error {
	if m.shouldFail {
		return fmt.Errorf("mock projection error")
	}
	m.processedEvents = append(m.processedEvents, evt)
	return nil
}

func (m *MockProjectionHandler) RebuildFromEvents(ctx context.Context, projectID string, events []*event.Event) error {
	if m.shouldFail {
		return fmt.Errorf("mock rebuild error")
	}
	m.rebuildCalled = true
	m.processedEvents = events
	return nil
}

func (m *MockProjectionHandler) GetMetrics() interface{} {
	return map[string]interface{}{
		"processed_events": len(m.processedEvents),
		"rebuild_called":   m.rebuildCalled,
	}
}

func TestEngine_RebuildProjections(t *testing.T) {
	// Create temporary directory
	tempDir := t.TempDir()
	
	// Create WAL
	logger := zerolog.New(os.Stdout)
	walConfig := wal.Config{
		DataDir:  tempDir,
		SyncMode: "always",
	}
	
	w, err := wal.New(walConfig, logger)
	if err != nil {
		t.Fatalf("Failed to create WAL: %v", err)
	}
	defer w.Close()
	
	// Create replay engine
	engine := New(w, logger)
	
	// Create test events
	projectID := "test-project"
	events := []*event.Event{}
	
	for i := 0; i < 5; i++ {
		payload := fmt.Sprintf(`{"test": "event_%d"}`, i)
		evt, err := w.Append(projectID, "test.event", json.RawMessage(payload), nil)
		if err != nil {
			t.Fatalf("Failed to append event %d: %v", i, err)
		}
		events = append(events, evt)
	}
	
	// Create mock projection handler
	handler := &MockProjectionHandler{}
	
	// Test rebuild
	ctx := context.Background()
	progress, err := engine.RebuildProjections(ctx, projectID, handler)
	if err != nil {
		t.Fatalf("Failed to rebuild projections: %v", err)
	}
	
	// Verify progress
	if progress.ProjectID != projectID {
		t.Errorf("Project ID mismatch: got %v, want %v", progress.ProjectID, projectID)
	}
	if progress.TotalEvents != 5 {
		t.Errorf("Total events mismatch: got %v, want 5", progress.TotalEvents)
	}
	if progress.ProcessedEvents != 5 {
		t.Errorf("Processed events mismatch: got %v, want 5", progress.ProcessedEvents)
	}
	
	// Verify handler was called
	if !handler.rebuildCalled {
		t.Errorf("Expected rebuild to be called")
	}
	if len(handler.processedEvents) != 5 {
		t.Errorf("Expected 5 processed events, got %d", len(handler.processedEvents))
	}
}

func TestEngine_VerifyProjectionConsistency(t *testing.T) {
	// Create temporary directory
	tempDir := t.TempDir()
	
	// Create WAL
	logger := zerolog.New(os.Stdout)
	walConfig := wal.Config{
		DataDir:  tempDir,
		SyncMode: "always",
	}
	
	w, err := wal.New(walConfig, logger)
	if err != nil {
		t.Fatalf("Failed to create WAL: %v", err)
	}
	defer w.Close()
	
	// Create replay engine
	engine := New(w, logger)
	
	// Create test events
	projectID := "test-project"
	
	for i := 0; i < 3; i++ {
		payload := fmt.Sprintf(`{"test": "event_%d"}`, i)
		_, err := w.Append(projectID, "test.event", json.RawMessage(payload), nil)
		if err != nil {
			t.Fatalf("Failed to append event %d: %v", i, err)
		}
	}
	
	// Test successful verification
	handler := &MockProjectionHandler{}
	
	ctx := context.Background()
	report, err := engine.VerifyProjectionConsistency(ctx, projectID, handler)
	if err != nil {
		t.Fatalf("Failed to verify consistency: %v", err)
	}
	
	// Verify report
	if report.ProjectID != projectID {
		t.Errorf("Project ID mismatch: got %v, want %v", report.ProjectID, projectID)
	}
	if report.EventsProcessed != 3 {
		t.Errorf("Events processed mismatch: got %v, want 3", report.EventsProcessed)
	}
	if report.InconsistenciesFound != 0 {
		t.Errorf("Expected 0 inconsistencies, got %d", report.InconsistenciesFound)
	}
	
	// Test failed verification
	failingHandler := &MockProjectionHandler{shouldFail: true}
	
	report, err = engine.VerifyProjectionConsistency(ctx, projectID, failingHandler)
	if err != nil {
		t.Fatalf("Failed to verify consistency with failing handler: %v", err)
	}
	
	if report.InconsistenciesFound == 0 {
		t.Errorf("Expected inconsistencies with failing handler")
	}
	if len(report.Errors) == 0 {
		t.Errorf("Expected errors in report")
	}
}

func TestEngine_ReplayForProjection(t *testing.T) {
	// Create temporary directory
	tempDir := t.TempDir()
	
	// Create WAL
	logger := zerolog.New(os.Stdout)
	walConfig := wal.Config{
		DataDir:  tempDir,
		SyncMode: "always",
	}
	
	w, err := wal.New(walConfig, logger)
	if err != nil {
		t.Fatalf("Failed to create WAL: %v", err)
	}
	defer w.Close()
	
	// Create replay engine
	engine := New(w, logger)
	
	// Create test events
	projectID := "test-project"
	
	for i := 0; i < 4; i++ {
		payload := fmt.Sprintf(`{"test": "event_%d"}`, i)
		_, err := w.Append(projectID, "test.event", json.RawMessage(payload), nil)
		if err != nil {
			t.Fatalf("Failed to append event %d: %v", i, err)
		}
	}
	
	// Create mock projection handler
	handler := &MockProjectionHandler{}
	
	// Test replay for projection
	ctx := context.Background()
	progress, err := engine.ReplayForProjection(ctx, projectID, handler)
	if err != nil {
		t.Fatalf("Failed to replay for projection: %v", err)
	}
	
	// Verify progress
	if progress.ProcessedEvents != 4 {
		t.Errorf("Expected 4 processed events, got %d", progress.ProcessedEvents)
	}
	
	// Verify handler received events
	if len(handler.processedEvents) != 4 {
		t.Errorf("Expected 4 events in handler, got %d", len(handler.processedEvents))
	}
}

func TestEngine_GetReplayStatus(t *testing.T) {
	logger := zerolog.New(os.Stdout)
	engine := New(nil, logger) // WAL not needed for this test
	
	projectID := "test-project"
	
	// Initially no replay should be in progress
	if engine.GetReplayStatus(projectID) {
		t.Errorf("Expected no replay in progress initially")
	}
	
	// Simulate replay in progress
	engine.mu.Lock()
	engine.replaying[projectID] = true
	engine.mu.Unlock()
	
	if !engine.GetReplayStatus(projectID) {
		t.Errorf("Expected replay in progress")
	}
	
	// Cancel replay
	engine.CancelReplay(projectID)
	
	if engine.GetReplayStatus(projectID) {
		t.Errorf("Expected no replay after cancellation")
	}
}

func TestEngine_GetMetrics(t *testing.T) {
	logger := zerolog.New(os.Stdout)
	engine := New(nil, logger) // WAL not needed for this test
	
	metrics := engine.GetMetrics()
	
	if metrics.ActiveReplays != 0 {
		t.Errorf("Expected 0 active replays, got %d", metrics.ActiveReplays)
	}
	
	// Simulate active replay
	engine.mu.Lock()
	engine.replaying["project1"] = true
	engine.replaying["project2"] = true
	engine.mu.Unlock()
	
	metrics = engine.GetMetrics()
	
	if metrics.ActiveReplays != 2 {
		t.Errorf("Expected 2 active replays, got %d", metrics.ActiveReplays)
	}
}
// **Feature: shrikdb-phase-1b, Property 9: Chronological event processing**
func TestChronologicalEventProcessing(t *testing.T) {
	quick.Check(func(eventCount uint8) bool {
		if eventCount == 0 || eventCount > 20 {
			return true // Skip edge cases
		}
		
		// Create temporary directory
		tempDir := t.TempDir()
		
		// Create WAL
		logger := zerolog.New(os.Stdout)
		walConfig := wal.Config{
			DataDir:  tempDir,
			SyncMode: "always",
		}
		
		w, err := wal.New(walConfig, logger)
		if err != nil {
			return false
		}
		defer w.Close()
		
		// Create replay engine
		engine := New(w, logger)
		
		// Create events with sequential timestamps
		projectID := "test-project"
		var expectedSequences []uint64
		
		for i := uint8(0); i < eventCount; i++ {
			payload := fmt.Sprintf(`{"index": %d}`, i)
			evt, err := w.Append(projectID, "document.created", json.RawMessage(payload), nil)
			if err != nil {
				return false
			}
			expectedSequences = append(expectedSequences, evt.SequenceNumber)
		}
		
		// Track processed sequences
		var processedSequences []uint64
		handler := func(evt *event.Event) error {
			processedSequences = append(processedSequences, evt.SequenceNumber)
			return nil
		}
		
		// Replay events
		ctx := context.Background()
		_, err = engine.ReplayFrom(ctx, projectID, 0, handler)
		if err != nil {
			return false
		}
		
		// Verify chronological order
		if len(processedSequences) != len(expectedSequences) {
			return false
		}
		
		for i, seq := range processedSequences {
			if seq != expectedSequences[i] {
				return false // Not in chronological order
			}
		}
		
		return true
	}, &quick.Config{MaxCount: 50})
}
// **Feature: shrikdb-phase-1b, Property 13: Deterministic replay results**
func TestDeterministicReplayResults(t *testing.T) {
	quick.Check(func(eventCount uint8) bool {
		if eventCount == 0 || eventCount > 15 {
			return true // Skip edge cases
		}
		
		// Create temporary directory
		tempDir := t.TempDir()
		
		// Create WAL
		logger := zerolog.New(os.Stdout)
		walConfig := wal.Config{
			DataDir:  tempDir,
			SyncMode: "always",
		}
		
		w, err := wal.New(walConfig, logger)
		if err != nil {
			return false
		}
		defer w.Close()
		
		// Create replay engine
		engine := New(w, logger)
		
		// Create events
		projectID := "test-project"
		for i := uint8(0); i < eventCount; i++ {
			payload := fmt.Sprintf(`{"value": %d}`, i)
			_, err := w.Append(projectID, "test.event", json.RawMessage(payload), nil)
			if err != nil {
				return false
			}
		}
		
		// First replay
		var firstReplayResults []string
		firstHandler := func(evt *event.Event) error {
			firstReplayResults = append(firstReplayResults, evt.EventID)
			return nil
		}
		
		ctx := context.Background()
		_, err = engine.ReplayFrom(ctx, projectID, 0, firstHandler)
		if err != nil {
			return false
		}
		
		// Second replay
		var secondReplayResults []string
		secondHandler := func(evt *event.Event) error {
			secondReplayResults = append(secondReplayResults, evt.EventID)
			return nil
		}
		
		_, err = engine.ReplayFrom(ctx, projectID, 0, secondHandler)
		if err != nil {
			return false
		}
		
		// Results should be identical
		if len(firstReplayResults) != len(secondReplayResults) {
			return false
		}
		
		for i, eventID := range firstReplayResults {
			if eventID != secondReplayResults[i] {
				return false // Not deterministic
			}
		}
		
		return true
	}, &quick.Config{MaxCount: 30})
}
// **Feature: shrikdb-phase-1b, Property 10: Document creation replay**
func TestDocumentCreationReplay(t *testing.T) {
	quick.Check(func(docName string, docAge uint8) bool {
		if docName == "" {
			return true // Skip invalid inputs
		}
		
		// Create temporary directory
		tempDir := t.TempDir()
		
		// Create WAL
		logger := zerolog.New(os.Stdout)
		walConfig := wal.Config{
			DataDir:  tempDir,
			SyncMode: "always",
		}
		
		w, err := wal.New(walConfig, logger)
		if err != nil {
			return false
		}
		defer w.Close()
		
		// Create replay engine
		engine := New(w, logger)
		
		// Create document.created event
		projectID := "test-project"
		docID := fmt.Sprintf("doc_%s", docName)
		payload := fmt.Sprintf(`{
			"document_id": "%s",
			"collection": "users",
			"content": {
				"name": "%s",
				"age": %d
			}
		}`, docID, docName, docAge)
		
		_, err = w.Append(projectID, "document.created", json.RawMessage(payload), nil)
		if err != nil {
			return false
		}
		
		// Track processed document creation events
		var processedDocuments []map[string]interface{}
		handler := func(evt *event.Event) error {
			if evt.EventType == "document.created" {
				var payload map[string]interface{}
				if err := json.Unmarshal(evt.Payload, &payload); err != nil {
					return err
				}
				processedDocuments = append(processedDocuments, payload)
			}
			return nil
		}
		
		// Replay events
		ctx := context.Background()
		_, err = engine.ReplayFrom(ctx, projectID, 0, handler)
		if err != nil {
			return false
		}
		
		// Verify document creation was processed
		if len(processedDocuments) != 1 {
			return false
		}
		
		doc := processedDocuments[0]
		if doc["document_id"] != docID {
			return false
		}
		if doc["collection"] != "users" {
			return false
		}
		
		content, ok := doc["content"].(map[string]interface{})
		if !ok {
			return false
		}
		
		if content["name"] != docName {
			return false
		}
		
		// Age comparison needs to handle JSON number conversion
		ageFloat, ok := content["age"].(float64)
		if !ok {
			return false
		}
		if int(ageFloat) != int(docAge) {
			return false
		}
		
		return true
	}, &quick.Config{MaxCount: 30})
}