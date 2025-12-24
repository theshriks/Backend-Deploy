package api

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/leanovate/gopter"
	"github.com/leanovate/gopter/gen"
	"github.com/leanovate/gopter/prop"
	"shrikdb/pkg/wal"

	"github.com/rs/zerolog"
)

func setupTestService(t *testing.T) (*Service, string) {
	t.Helper()

	tmpDir, err := os.MkdirTemp("", "shrikdb-api-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}

	logger := zerolog.New(zerolog.NewTestWriter(t)).With().Timestamp().Logger()
	config := Config{
		DataDir: tmpDir,
		WAL:     wal.DefaultConfig(tmpDir),
	}

	svc, err := NewService(config, logger)
	if err != nil {
		os.RemoveAll(tmpDir)
		t.Fatalf("Failed to create service: %v", err)
	}

	return svc, tmpDir
}

func TestAPI_CreateProject(t *testing.T) {
	svc, tmpDir := setupTestService(t)
	defer os.RemoveAll(tmpDir)
	defer svc.Close()

	resp, err := svc.CreateProject(context.Background(), &CreateProjectRequest{
		ProjectID: "test-project",
	})

	if err != nil {
		t.Fatalf("CreateProject failed: %v", err)
	}

	if !resp.Success {
		t.Fatalf("CreateProject not successful: %s", resp.Error)
	}

	if resp.ClientID == "" {
		t.Error("ClientID should not be empty")
	}

	if resp.ClientKey == "" {
		t.Error("ClientKey should not be empty")
	}

	if resp.ProjectID != "test-project" {
		t.Errorf("ProjectID = %s, want test-project", resp.ProjectID)
	}
}

func TestAPI_AppendEvent(t *testing.T) {
	svc, tmpDir := setupTestService(t)
	defer os.RemoveAll(tmpDir)
	defer svc.Close()

	// Create project first
	createResp, _ := svc.CreateProject(context.Background(), &CreateProjectRequest{
		ProjectID: "test-project",
	})

	// Append event
	payload := json.RawMessage(`{"user": "alice", "action": "login"}`)
	resp, err := svc.AppendEvent(context.Background(), &AppendEventRequest{
		ClientID:  createResp.ClientID,
		ClientKey: createResp.ClientKey,
		EventType: "user.login",
		Payload:   payload,
	})

	if err != nil {
		t.Fatalf("AppendEvent failed: %v", err)
	}

	if !resp.Success {
		t.Fatalf("AppendEvent not successful: %s", resp.Error)
	}

	if resp.Event == nil {
		t.Fatal("Event should not be nil")
	}

	if resp.Event.SequenceNumber != 1 {
		t.Errorf("SequenceNumber = %d, want 1", resp.Event.SequenceNumber)
	}

	if resp.Event.EventType != "user.login" {
		t.Errorf("EventType = %s, want user.login", resp.Event.EventType)
	}
}

func TestAPI_ReadEvents(t *testing.T) {
	svc, tmpDir := setupTestService(t)
	defer os.RemoveAll(tmpDir)
	defer svc.Close()

	// Create project
	createResp, _ := svc.CreateProject(context.Background(), &CreateProjectRequest{
		ProjectID: "test-project",
	})

	// Append events
	for i := 0; i < 5; i++ {
		payload := json.RawMessage(`{"index": ` + string(rune('0'+i)) + `}`)
		svc.AppendEvent(context.Background(), &AppendEventRequest{
			ClientID:  createResp.ClientID,
			ClientKey: createResp.ClientKey,
			EventType: "test.event",
			Payload:   payload,
		})
	}

	// Read events
	resp, err := svc.ReadEvents(context.Background(), &ReadEventsRequest{
		ClientID:     createResp.ClientID,
		ClientKey:    createResp.ClientKey,
		FromSequence: 0,
	})

	if err != nil {
		t.Fatalf("ReadEvents failed: %v", err)
	}

	if !resp.Success {
		t.Fatalf("ReadEvents not successful: %s", resp.Error)
	}

	if resp.Count != 5 {
		t.Errorf("Count = %d, want 5", resp.Count)
	}
}

func TestAPI_ReadEventsWithLimit(t *testing.T) {
	svc, tmpDir := setupTestService(t)
	defer os.RemoveAll(tmpDir)
	defer svc.Close()

	// Create project
	createResp, _ := svc.CreateProject(context.Background(), &CreateProjectRequest{
		ProjectID: "test-project",
	})

	// Append events
	for i := 0; i < 10; i++ {
		payload := json.RawMessage(`{"index": ` + string(rune('0'+i)) + `}`)
		svc.AppendEvent(context.Background(), &AppendEventRequest{
			ClientID:  createResp.ClientID,
			ClientKey: createResp.ClientKey,
			EventType: "test.event",
			Payload:   payload,
		})
	}

	// Read with limit
	resp, _ := svc.ReadEvents(context.Background(), &ReadEventsRequest{
		ClientID:     createResp.ClientID,
		ClientKey:    createResp.ClientKey,
		FromSequence: 0,
		Limit:        3,
	})

	if resp.Count != 3 {
		t.Errorf("Count = %d, want 3", resp.Count)
	}
}

func TestAPI_Replay(t *testing.T) {
	svc, tmpDir := setupTestService(t)
	defer os.RemoveAll(tmpDir)
	defer svc.Close()

	// Create project
	createResp, _ := svc.CreateProject(context.Background(), &CreateProjectRequest{
		ProjectID: "test-project",
	})

	// Append events
	for i := 0; i < 10; i++ {
		payload := json.RawMessage(`{"index": ` + string(rune('0'+i)) + `}`)
		svc.AppendEvent(context.Background(), &AppendEventRequest{
			ClientID:  createResp.ClientID,
			ClientKey: createResp.ClientKey,
			EventType: "test.event",
			Payload:   payload,
		})
	}

	// Replay
	resp, err := svc.Replay(context.Background(), &ReplayRequest{
		ClientID:  createResp.ClientID,
		ClientKey: createResp.ClientKey,
	})

	if err != nil {
		t.Fatalf("Replay failed: %v", err)
	}

	if !resp.Success {
		t.Fatalf("Replay not successful: %s", resp.Error)
	}

	if resp.Progress.ProcessedEvents != 10 {
		t.Errorf("ProcessedEvents = %d, want 10", resp.Progress.ProcessedEvents)
	}
}

func TestAPI_AuthFailure(t *testing.T) {
	svc, tmpDir := setupTestService(t)
	defer os.RemoveAll(tmpDir)
	defer svc.Close()

	// Try to append without valid credentials
	payload := json.RawMessage(`{"data": "test"}`)
	resp, err := svc.AppendEvent(context.Background(), &AppendEventRequest{
		ClientID:  "invalid",
		ClientKey: "invalid",
		EventType: "test",
		Payload:   payload,
	})

	if err != ErrUnauthorized {
		t.Errorf("Expected ErrUnauthorized, got %v", err)
	}

	if resp.Success {
		t.Error("Should not be successful with invalid credentials")
	}
}

func TestAPI_ProjectIsolation(t *testing.T) {
	svc, tmpDir := setupTestService(t)
	defer os.RemoveAll(tmpDir)
	defer svc.Close()

	// Create two projects
	projA, _ := svc.CreateProject(context.Background(), &CreateProjectRequest{ProjectID: "project-a"})
	projB, _ := svc.CreateProject(context.Background(), &CreateProjectRequest{ProjectID: "project-b"})

	// Append to project A
	payload := json.RawMessage(`{"data": "test"}`)
	svc.AppendEvent(context.Background(), &AppendEventRequest{
		ClientID:  projA.ClientID,
		ClientKey: projA.ClientKey,
		EventType: "test",
		Payload:   payload,
	})

	// Try to read project A's events with project B's credentials
	resp, _ := svc.ReadEvents(context.Background(), &ReadEventsRequest{
		ClientID:  projB.ClientID,
		ClientKey: projB.ClientKey,
	})

	// Should return empty (project B has no events)
	if resp.Count != 0 {
		t.Errorf("Project B should have 0 events, got %d", resp.Count)
	}
}

func TestAPI_HealthCheck(t *testing.T) {
	svc, tmpDir := setupTestService(t)
	defer os.RemoveAll(tmpDir)
	defer svc.Close()

	health := svc.HealthCheck()

	if !health.Healthy {
		t.Error("Service should be healthy")
	}

	if health.WALStatus != "operational" {
		t.Errorf("WALStatus = %s, want operational", health.WALStatus)
	}
}

func TestAPI_Metrics(t *testing.T) {
	svc, tmpDir := setupTestService(t)
	defer os.RemoveAll(tmpDir)
	defer svc.Close()

	// Create project and append events
	createResp, _ := svc.CreateProject(context.Background(), &CreateProjectRequest{
		ProjectID: "test-project",
	})

	for i := 0; i < 5; i++ {
		payload := json.RawMessage(`{"data": "test"}`)
		svc.AppendEvent(context.Background(), &AppendEventRequest{
			ClientID:  createResp.ClientID,
			ClientKey: createResp.ClientKey,
			EventType: "test",
			Payload:   payload,
		})
	}

	metrics := svc.GetMetrics()

	if metrics.AppendRequests != 5 {
		t.Errorf("AppendRequests = %d, want 5", metrics.AppendRequests)
	}
}

func TestAPI_DuplicateProject(t *testing.T) {
	svc, tmpDir := setupTestService(t)
	defer os.RemoveAll(tmpDir)
	defer svc.Close()

	// Create project
	svc.CreateProject(context.Background(), &CreateProjectRequest{
		ProjectID: "test-project",
	})

	// Try to create again
	resp, _ := svc.CreateProject(context.Background(), &CreateProjectRequest{
		ProjectID: "test-project",
	})

	if resp.Success {
		t.Error("Should not allow duplicate project creation")
	}
}

// **Feature: shrikdb-phase-1a, Property 7: Input Validation and Security**
// **Validates: Requirements 3.3, 4.1**
func TestProperty_InputValidationAndSecurity(t *testing.T) {
	properties := gopter.NewProperties(nil)

	properties.Property("malformed payloads are rejected", prop.ForAll(
		func(projectID, eventType string, invalidJSON string) bool {
			// Skip invalid inputs
			if projectID == "" || len(projectID) > 20 || eventType == "" || len(eventType) > 20 {
				return true
			}

			svc, tmpDir := setupTestService(t)
			defer os.RemoveAll(tmpDir)
			defer svc.Close()

			// Create project
			createResp, err := svc.CreateProject(context.Background(), &CreateProjectRequest{
				ProjectID: projectID,
			})
			if err != nil {
				return true
			}

			// Try to append with invalid JSON
			resp, _ := svc.AppendEvent(context.Background(), &AppendEventRequest{
				ClientID:  createResp.ClientID,
				ClientKey: createResp.ClientKey,
				EventType: eventType,
				Payload:   json.RawMessage(invalidJSON),
			})

			// Should fail for invalid JSON
			if !json.Valid([]byte(invalidJSON)) {
				return !resp.Success
			}

			return true
		},
		gen.AlphaString().SuchThat(func(s string) bool { return len(s) > 0 && len(s) <= 15 }),
		gen.AlphaString().SuchThat(func(s string) bool { return len(s) > 0 && len(s) <= 15 }),
		gen.Const("{invalid}"),
	))

	properties.Property("oversized payloads are rejected", prop.ForAll(
		func(projectID, eventType string) bool {
			// Skip invalid inputs
			if projectID == "" || len(projectID) > 20 || eventType == "" || len(eventType) > 20 {
				return true
			}

			svc, tmpDir := setupTestService(t)
			defer os.RemoveAll(tmpDir)
			defer svc.Close()

			// Create project
			createResp, err := svc.CreateProject(context.Background(), &CreateProjectRequest{
				ProjectID: projectID,
			})
			if err != nil {
				return true
			}

			// Create oversized payload (> 1MB)
			largeData := make([]byte, 2*1024*1024) // 2MB
			for i := range largeData {
				largeData[i] = 'a'
			}
			oversizedPayload := json.RawMessage(`{"data":"` + string(largeData) + `"}`)

			// Try to append oversized payload
			resp, _ := svc.AppendEvent(context.Background(), &AppendEventRequest{
				ClientID:  createResp.ClientID,
				ClientKey: createResp.ClientKey,
				EventType: eventType,
				Payload:   oversizedPayload,
			})

			// Should fail
			return !resp.Success
		},
		gen.AlphaString().SuchThat(func(s string) bool { return len(s) > 0 && len(s) <= 15 }),
		gen.AlphaString().SuchThat(func(s string) bool { return len(s) > 0 && len(s) <= 15 }),
	))

	properties.Property("empty required fields are rejected", prop.ForAll(
		func(projectID string) bool {
			// Skip invalid inputs
			if projectID == "" || len(projectID) > 20 {
				return true
			}

			svc, tmpDir := setupTestService(t)
			defer os.RemoveAll(tmpDir)
			defer svc.Close()

			// Create project
			createResp, err := svc.CreateProject(context.Background(), &CreateProjectRequest{
				ProjectID: projectID,
			})
			if err != nil {
				return true
			}

			validPayload := json.RawMessage(`{"data":"test"}`)

			// Test empty event type
			resp1, _ := svc.AppendEvent(context.Background(), &AppendEventRequest{
				ClientID:  createResp.ClientID,
				ClientKey: createResp.ClientKey,
				EventType: "",
				Payload:   validPayload,
			})

			// Test empty payload
			resp2, _ := svc.AppendEvent(context.Background(), &AppendEventRequest{
				ClientID:  createResp.ClientID,
				ClientKey: createResp.ClientKey,
				EventType: "test",
				Payload:   nil,
			})

			// Both should fail
			return !resp1.Success && !resp2.Success
		},
		gen.AlphaString().SuchThat(func(s string) bool { return len(s) > 0 && len(s) <= 15 }),
	))

	properties.TestingRun(t, gopter.ConsoleReporter(false))
}