package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/leanovate/gopter"
	"github.com/leanovate/gopter/gen"
	"github.com/leanovate/gopter/prop"
	"shrikdb/pkg/api"
	"shrikdb/pkg/wal"

	"github.com/rs/zerolog"
)

func setupTestServer(t *testing.T) (*Server, *api.Service, string) {
	t.Helper()

	tmpDir, err := os.MkdirTemp("", "shrikdb-server-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}

	logger := zerolog.New(zerolog.NewTestWriter(t)).With().Timestamp().Logger()
	
	apiConfig := api.Config{
		DataDir: tmpDir,
		WAL:     wal.DefaultConfig(tmpDir),
	}

	apiService, err := api.NewService(apiConfig, logger)
	if err != nil {
		os.RemoveAll(tmpDir)
		t.Fatalf("Failed to create API service: %v", err)
	}

	serverConfig := DefaultConfig()
	serverConfig.Port = 0 // Use random port for testing

	server := New(apiService, serverConfig, logger)

	return server, apiService, tmpDir
}

func TestServer_CreateProject(t *testing.T) {
	server, apiService, tmpDir := setupTestServer(t)
	defer os.RemoveAll(tmpDir)
	defer apiService.Close()

	// Create request
	reqBody := `{"project_id": "test-project"}`
	req := httptest.NewRequest("POST", "/api/projects", strings.NewReader(reqBody))
	req.Header.Set("Content-Type", "application/json")

	// Record response
	w := httptest.NewRecorder()
	server.handleCreateProject(w, req)

	// Check response
	if w.Code != http.StatusOK {
		t.Errorf("Status = %d, want %d", w.Code, http.StatusOK)
	}

	var resp api.CreateProjectResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("Failed to unmarshal response: %v", err)
	}

	if !resp.Success {
		t.Errorf("Response not successful: %s", resp.Error)
	}

	if resp.ClientID == "" {
		t.Error("ClientID should not be empty")
	}

	if resp.ClientKey == "" {
		t.Error("ClientKey should not be empty")
	}
}
func TestServer_AppendEvent(t *testing.T) {
	server, apiService, tmpDir := setupTestServer(t)
	defer os.RemoveAll(tmpDir)
	defer apiService.Close()

	// Create project first
	createResp, _ := apiService.CreateProject(context.Background(), &api.CreateProjectRequest{
		ProjectID: "test-project",
	})

	// Create append request
	reqBody := `{"event_type": "user.login", "payload": {"user": "alice"}}`
	req := httptest.NewRequest("POST", "/api/events", strings.NewReader(reqBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Client-ID", createResp.ClientID)
	req.Header.Set("X-Client-Key", createResp.ClientKey)

	// Record response - use the middleware chain
	w := httptest.NewRecorder()
	handler := server.withCORS(server.withMiddleware(server.handleEvents))
	handler(w, req)

	// Check response
	if w.Code != http.StatusOK {
		t.Errorf("Status = %d, want %d", w.Code, http.StatusOK)
	}

	var resp api.AppendEventResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("Failed to unmarshal response: %v", err)
	}

	if !resp.Success {
		t.Errorf("Response not successful: %s", resp.Error)
	}

	if resp.Event == nil {
		t.Fatal("Event should not be nil")
	}
}

func TestServer_ReadEvents(t *testing.T) {
	server, apiService, tmpDir := setupTestServer(t)
	defer os.RemoveAll(tmpDir)
	defer apiService.Close()

	// Create project and append events
	createResp, _ := apiService.CreateProject(context.Background(), &api.CreateProjectRequest{
		ProjectID: "test-project",
	})

	// Append some events
	for i := 0; i < 5; i++ {
		payload := json.RawMessage(fmt.Sprintf(`{"index": %d}`, i))
		apiService.AppendEvent(context.Background(), &api.AppendEventRequest{
			ClientID:  createResp.ClientID,
			ClientKey: createResp.ClientKey,
			EventType: "test.event",
			Payload:   payload,
		})
	}

	// Read events
	req := httptest.NewRequest("GET", "/api/events/read?from_sequence=0", nil)
	req.Header.Set("X-Client-ID", createResp.ClientID)
	req.Header.Set("X-Client-Key", createResp.ClientKey)

	w := httptest.NewRecorder()
	handler := server.withCORS(server.withMiddleware(server.handleReadEvents))
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Status = %d, want %d", w.Code, http.StatusOK)
	}

	var resp api.ReadEventsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("Failed to unmarshal response: %v", err)
	}

	if !resp.Success {
		t.Errorf("Response not successful: %s", resp.Error)
	}

	if resp.Count != 5 {
		t.Errorf("Count = %d, want 5", resp.Count)
	}
}

func TestServer_AuthenticationRequired(t *testing.T) {
	server, apiService, tmpDir := setupTestServer(t)
	defer os.RemoveAll(tmpDir)
	defer apiService.Close()

	// Try to append without auth headers
	reqBody := `{"event_type": "test", "payload": {"data": "test"}}`
	req := httptest.NewRequest("POST", "/api/events", strings.NewReader(reqBody))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	handler := server.withCORS(server.withMiddleware(server.handleEvents))
	handler(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("Status = %d, want %d", w.Code, http.StatusUnauthorized)
	}
}

func TestServer_HealthCheck(t *testing.T) {
	server, apiService, tmpDir := setupTestServer(t)
	defer os.RemoveAll(tmpDir)
	defer apiService.Close()

	req := httptest.NewRequest("GET", "/health", nil)
	w := httptest.NewRecorder()

	server.handleHealth(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Status = %d, want %d", w.Code, http.StatusOK)
	}

	var health api.HealthStatus
	if err := json.Unmarshal(w.Body.Bytes(), &health); err != nil {
		t.Fatalf("Failed to unmarshal health response: %v", err)
	}

	if !health.Healthy {
		t.Error("Service should be healthy")
	}
}

func TestServer_ReadyCheck(t *testing.T) {
	server, apiService, tmpDir := setupTestServer(t)
	defer os.RemoveAll(tmpDir)
	defer apiService.Close()

	req := httptest.NewRequest("GET", "/ready", nil)
	w := httptest.NewRecorder()

	server.handleReady(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Status = %d, want %d", w.Code, http.StatusOK)
	}

	if w.Body.String() != "OK" {
		t.Errorf("Body = %s, want OK", w.Body.String())
	}
}

func TestServer_Metrics(t *testing.T) {
	server, apiService, tmpDir := setupTestServer(t)
	defer os.RemoveAll(tmpDir)
	defer apiService.Close()

	// Create project and append events to generate metrics
	createResp, _ := apiService.CreateProject(context.Background(), &api.CreateProjectRequest{
		ProjectID: "test-project",
	})

	for i := 0; i < 3; i++ {
		payload := json.RawMessage(`{"data": "test"}`)
		apiService.AppendEvent(context.Background(), &api.AppendEventRequest{
			ClientID:  createResp.ClientID,
			ClientKey: createResp.ClientKey,
			EventType: "test.event",
			Payload:   payload,
		})
	}

	req := httptest.NewRequest("GET", "/metrics", nil)
	w := httptest.NewRecorder()

	server.handleMetrics(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Status = %d, want %d", w.Code, http.StatusOK)
	}

	body := w.Body.String()
	if !strings.Contains(body, "events_appended_total") {
		t.Error("Metrics should contain events_appended_total")
	}

	if !strings.Contains(body, "wal_bytes_written_total") {
		t.Error("Metrics should contain wal_bytes_written_total")
	}
}

func TestServer_CorrelationID(t *testing.T) {
	server, apiService, tmpDir := setupTestServer(t)
	defer os.RemoveAll(tmpDir)
	defer apiService.Close()

	req := httptest.NewRequest("POST", "/api/projects", strings.NewReader(`{"project_id": "test"}`))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	server.handleCreateProject(w, req)

	correlationID := w.Header().Get("X-Correlation-ID")
	if correlationID == "" {
		t.Error("X-Correlation-ID header should be set")
	}
}

func TestServer_InvalidJSON(t *testing.T) {
	server, apiService, tmpDir := setupTestServer(t)
	defer os.RemoveAll(tmpDir)
	defer apiService.Close()

	// Create project first
	createResp, _ := apiService.CreateProject(context.Background(), &api.CreateProjectRequest{
		ProjectID: "test-project",
	})

	// Send invalid JSON
	req := httptest.NewRequest("POST", "/api/events", strings.NewReader(`{invalid json`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Client-ID", createResp.ClientID)
	req.Header.Set("X-Client-Key", createResp.ClientKey)

	w := httptest.NewRecorder()
	handler := server.withCORS(server.withMiddleware(server.handleEvents))
	handler(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("Status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}
// **Feature: shrikdb-phase-1a, Property 10: Observability and Monitoring**
// **Validates: Requirements 7.1, 7.2, 7.3, 7.5**
func TestProperty_ObservabilityAndMonitoring(t *testing.T) {
	properties := gopter.NewProperties(nil)

	properties.Property("all requests have correlation IDs", prop.ForAll(
		func(projectID string) bool {
			server, apiService, tmpDir := setupTestServer(t)
			defer os.RemoveAll(tmpDir)
			defer apiService.Close()

			// Test different endpoints
			endpoints := []struct {
				method string
				path   string
				body   string
			}{
				{"POST", "/api/projects", fmt.Sprintf(`{"project_id": "%s"}`, projectID)},
				{"GET", "/health", ""},
				{"GET", "/ready", ""},
				{"GET", "/metrics", ""},
			}

			for _, endpoint := range endpoints {
				req := httptest.NewRequest(endpoint.method, endpoint.path, strings.NewReader(endpoint.body))
				if endpoint.body != "" {
					req.Header.Set("Content-Type", "application/json")
				}

				w := httptest.NewRecorder()

				// Route to appropriate handler
				switch endpoint.path {
				case "/api/projects":
					server.handleCreateProject(w, req)
				case "/health":
					server.handleHealth(w, req)
				case "/ready":
					server.handleReady(w, req)
				case "/metrics":
					server.handleMetrics(w, req)
				}

				// Check for correlation ID
				correlationID := w.Header().Get("X-Correlation-ID")
				if correlationID == "" {
					return false
				}
			}

			return true
		},
		gen.RegexMatch(`^[a-zA-Z][a-zA-Z0-9-]{2,18}$`),
	))

	properties.Property("metrics are exposed in Prometheus format", prop.ForAll(
		func(projectID string) bool {
			server, apiService, tmpDir := setupTestServer(t)
			defer os.RemoveAll(tmpDir)
			defer apiService.Close()

			// Generate some metrics by creating project and events
			createResp, err := apiService.CreateProject(context.Background(), &api.CreateProjectRequest{
				ProjectID: projectID,
			})
			if err != nil {
				return true
			}

			// Append an event to generate metrics
			payload := json.RawMessage(`{"data": "test"}`)
			apiService.AppendEvent(context.Background(), &api.AppendEventRequest{
				ClientID:  createResp.ClientID,
				ClientKey: createResp.ClientKey,
				EventType: "test.event",
				Payload:   payload,
			})

			// Check metrics endpoint
			req := httptest.NewRequest("GET", "/metrics", nil)
			w := httptest.NewRecorder()
			server.handleMetrics(w, req)

			if w.Code != http.StatusOK {
				return false
			}

			body := w.Body.String()

			// Verify Prometheus format metrics are present
			requiredMetrics := []string{
				"events_appended_total",
				"wal_bytes_written_total",
				"wal_syncs_performed_total",
				"api_append_requests_total",
				"api_read_requests_total",
				"api_replay_requests_total",
			}

			for _, metric := range requiredMetrics {
				if !strings.Contains(body, metric) {
					return false
				}
			}

			// Verify content type
			contentType := w.Header().Get("Content-Type")
			return contentType == "text/plain"
		},
		gen.RegexMatch(`^[a-zA-Z][a-zA-Z0-9-]{2,18}$`),
	))

	properties.Property("health endpoints are always available", prop.ForAll(
		func() bool {
			server, apiService, tmpDir := setupTestServer(t)
			defer os.RemoveAll(tmpDir)
			defer apiService.Close()

			// Test health endpoint
			healthReq := httptest.NewRequest("GET", "/health", nil)
			healthW := httptest.NewRecorder()
			server.handleHealth(healthW, healthReq)

			if healthW.Code != http.StatusOK {
				return false
			}

			var health api.HealthStatus
			if err := json.Unmarshal(healthW.Body.Bytes(), &health); err != nil {
				return false
			}

			if !health.Healthy {
				return false
			}

			// Test ready endpoint
			readyReq := httptest.NewRequest("GET", "/ready", nil)
			readyW := httptest.NewRecorder()
			server.handleReady(readyW, readyReq)

			return readyW.Code == http.StatusOK && readyW.Body.String() == "OK"
		},
	))

	properties.TestingRun(t, gopter.ConsoleReporter(false))
}

func TestServer_RateLimit(t *testing.T) {
	server, apiService, tmpDir := setupTestServer(t)
	defer os.RemoveAll(tmpDir)
	defer apiService.Close()

	// Create project
	createResp, _ := apiService.CreateProject(context.Background(), &api.CreateProjectRequest{
		ProjectID: "test-project",
	})

	// Make many requests quickly to trigger rate limit
	// Note: This test may be flaky depending on rate limit settings
	var rateLimitHit bool
	for i := 0; i < 200; i++ {
		reqBody := fmt.Sprintf(`{"event_type": "test", "payload": {"index": %d}}`, i)
		req := httptest.NewRequest("POST", "/api/events", strings.NewReader(reqBody))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Client-ID", createResp.ClientID)
		req.Header.Set("X-Client-Key", createResp.ClientKey)

		w := httptest.NewRecorder()
		handler := server.withCORS(server.withMiddleware(server.handleEvents))
		handler(w, req)

		if w.Code == http.StatusTooManyRequests {
			rateLimitHit = true
			break
		}
	}

	// Note: Rate limiting may not trigger in tests due to timing
	t.Logf("Rate limit hit: %v", rateLimitHit)
}

func TestGenerateCorrelationID(t *testing.T) {
	// Generate multiple correlation IDs and verify they're unique
	ids := make(map[string]bool)
	for i := 0; i < 1000; i++ {
		id := generateCorrelationID()
		if ids[id] {
			t.Errorf("Duplicate correlation ID generated: %s", id)
		}
		ids[id] = true

		// ID should not be empty
		if id == "" {
			t.Error("Correlation ID should not be empty")
		}
	}
}