// Package server implements the production HTTP server for ShrikDB Phase 1A.
// This provides the REST API endpoints with authentication, rate limiting, and observability.
package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"

	"shrikdb/pkg/api"

	"github.com/google/uuid"
	"github.com/rs/zerolog"
	"golang.org/x/time/rate"
)

// Server is the production HTTP server.
type Server struct {
	api      *api.Service
	logger   zerolog.Logger
	server   *http.Server
	limiters map[string]*rate.Limiter
	mu       sync.RWMutex
}

// Config holds server configuration.
type Config struct {
	Port         int
	ReadTimeout  time.Duration
	WriteTimeout time.Duration
	IdleTimeout  time.Duration
	RateLimit    int // requests per second per client
}

// DefaultConfig returns production-safe server defaults.
func DefaultConfig() Config {
	return Config{
		Port:         8080,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
		RateLimit:    100, // 100 req/sec per client
	}
}

// New creates a new production HTTP server.
func New(apiService *api.Service, config Config, logger zerolog.Logger) *Server {
	s := &Server{
		api:      apiService,
		logger:   logger.With().Str("component", "server").Logger(),
		limiters: make(map[string]*rate.Limiter),
	}

	mux := http.NewServeMux()
	
	// API endpoints
	mux.HandleFunc("/api/events", s.withCORS(s.withMiddleware(s.handleEvents)))
	mux.HandleFunc("/api/events/read", s.withCORS(s.withMiddleware(s.handleReadEvents)))
	mux.HandleFunc("/api/replay", s.withCORS(s.withMiddleware(s.handleReplay)))
	mux.HandleFunc("/api/projects", s.withCORS(s.handleCreateProject)) // No auth required for project creation
	
	// Health endpoints
	mux.HandleFunc("/health", s.withCORS(s.handleHealth))
	mux.HandleFunc("/ready", s.withCORS(s.handleReady))
	mux.HandleFunc("/metrics", s.withCORS(s.handleMetrics))

	s.server = &http.Server{
		Addr:         fmt.Sprintf(":%d", config.Port),
		Handler:      mux,
		ReadTimeout:  config.ReadTimeout,
		WriteTimeout: config.WriteTimeout,
		IdleTimeout:  config.IdleTimeout,
	}

	return s
}

// Start starts the HTTP server.
func (s *Server) Start() error {
	s.logger.Info().
		Str("addr", s.server.Addr).
		Msg("starting HTTP server")
	
	return s.server.ListenAndServe()
}

// Stop gracefully stops the HTTP server.
func (s *Server) Stop(ctx context.Context) error {
	s.logger.Info().Msg("stopping HTTP server")
	return s.server.Shutdown(ctx)
}

// withCORS adds CORS headers for frontend integration.
func (s *Server) withCORS(handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Set CORS headers
		w.Header().Set("Access-Control-Allow-Origin", "http://localhost:3000")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Client-ID, X-Client-Key, Authorization")
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		
		// Handle preflight requests
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		
		// Call the actual handler
		handler(w, r)
	}
}

// withMiddleware applies authentication, rate limiting, and logging.
func (s *Server) withMiddleware(handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		correlationID := generateCorrelationID()
		
		// Add correlation ID to response headers
		w.Header().Set("X-Correlation-ID", correlationID)
		
		// Create request logger with correlation ID
		reqLogger := s.logger.With().
			Str("correlation_id", correlationID).
			Str("method", r.Method).
			Str("path", r.URL.Path).
			Str("remote_addr", r.RemoteAddr).
			Logger()

		reqLogger.Info().Msg("request started")

		// Extract auth from headers
		clientID := r.Header.Get("X-Client-ID")
		clientKey := r.Header.Get("X-Client-Key")
		
		if clientID == "" || clientKey == "" {
			reqLogger.Warn().Msg("missing authentication headers")
			http.Error(w, "Missing authentication headers", http.StatusUnauthorized)
			return
		}

		// Rate limiting per client
		if !s.checkRateLimit(clientID) {
			reqLogger.Warn().Msg("rate limit exceeded")
			http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
			return
		}

		// Add context with correlation ID and logger
		ctx := context.WithValue(r.Context(), "correlation_id", correlationID)
		ctx = context.WithValue(ctx, "logger", reqLogger)
		ctx = context.WithValue(ctx, "client_id", clientID)
		ctx = context.WithValue(ctx, "client_key", clientKey)
		
		r = r.WithContext(ctx)

		// Call handler
		handler(w, r)

		// Log completion
		duration := time.Since(start)
		reqLogger.Info().
			Dur("duration", duration).
			Msg("request completed")
	}
}

// checkRateLimit implements per-client rate limiting.
func (s *Server) checkRateLimit(clientID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	limiter, exists := s.limiters[clientID]
	if !exists {
		limiter = rate.NewLimiter(rate.Limit(100), 10) // 100 req/sec, burst 10
		s.limiters[clientID] = limiter
	}

	return limiter.Allow()
}

// handleEvents handles POST /api/events
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	logger := r.Context().Value("logger").(zerolog.Logger)
	clientID := r.Context().Value("client_id").(string)
	clientKey := r.Context().Value("client_key").(string)

	var req struct {
		EventType string          `json:"event_type"`
		Payload   json.RawMessage `json:"payload"`
		Metadata  map[string]string `json:"metadata,omitempty"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		logger.Error().Err(err).Msg("failed to decode request")
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Validate payload size (max 1MB)
	if len(req.Payload) > 1024*1024 {
		logger.Warn().Int("payload_size", len(req.Payload)).Msg("payload too large")
		http.Error(w, "Payload too large", http.StatusRequestEntityTooLarge)
		return
	}

	// Call API service
	resp, err := s.api.AppendEvent(r.Context(), &api.AppendEventRequest{
		ClientID:  clientID,
		ClientKey: clientKey,
		EventType: req.EventType,
		Payload:   req.Payload,
		Metadata:  req.Metadata,
	})

	if err != nil {
		logger.Error().Err(err).Msg("append event failed")
		if err == api.ErrUnauthorized {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
		} else {
			http.Error(w, "Internal server error", http.StatusInternalServerError)
		}
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// handleReadEvents handles GET /api/events/read
func (s *Server) handleReadEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	logger := r.Context().Value("logger").(zerolog.Logger)
	clientID := r.Context().Value("client_id").(string)
	clientKey := r.Context().Value("client_key").(string)

	// Parse query parameters
	fromSeqStr := r.URL.Query().Get("from_sequence")
	limitStr := r.URL.Query().Get("limit")

	var fromSeq uint64
	var limit int
	var err error

	if fromSeqStr != "" {
		fromSeq, err = strconv.ParseUint(fromSeqStr, 10, 64)
		if err != nil {
			http.Error(w, "Invalid from_sequence", http.StatusBadRequest)
			return
		}
	}

	if limitStr != "" {
		limit, err = strconv.Atoi(limitStr)
		if err != nil || limit < 0 {
			http.Error(w, "Invalid limit", http.StatusBadRequest)
			return
		}
	}

	// Call API service
	resp, err := s.api.ReadEvents(r.Context(), &api.ReadEventsRequest{
		ClientID:     clientID,
		ClientKey:    clientKey,
		FromSequence: fromSeq,
		Limit:        limit,
	})

	if err != nil {
		logger.Error().Err(err).Msg("read events failed")
		if err == api.ErrUnauthorized {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
		} else {
			http.Error(w, "Internal server error", http.StatusInternalServerError)
		}
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// handleReplay handles POST /api/replay
func (s *Server) handleReplay(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	logger := r.Context().Value("logger").(zerolog.Logger)
	clientID := r.Context().Value("client_id").(string)
	clientKey := r.Context().Value("client_key").(string)

	var req struct {
		FromSequence uint64 `json:"from_sequence,omitempty"`
		VerifyOnly   bool   `json:"verify_only,omitempty"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		logger.Error().Err(err).Msg("failed to decode replay request")
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Call API service
	resp, err := s.api.Replay(r.Context(), &api.ReplayRequest{
		ClientID:     clientID,
		ClientKey:    clientKey,
		FromSequence: req.FromSequence,
		VerifyOnly:   req.VerifyOnly,
	})

	if err != nil {
		logger.Error().Err(err).Msg("replay failed")
		if err == api.ErrUnauthorized {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
		} else {
			http.Error(w, "Internal server error", http.StatusInternalServerError)
		}
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// handleCreateProject handles POST /api/projects
func (s *Server) handleCreateProject(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	correlationID := generateCorrelationID()
	w.Header().Set("X-Correlation-ID", correlationID)
	
	logger := s.logger.With().
		Str("correlation_id", correlationID).
		Str("method", r.Method).
		Str("path", r.URL.Path).
		Str("remote_addr", r.RemoteAddr).
		Logger()

	logger.Info().Msg("create project request started")

	var req struct {
		ProjectID string `json:"project_id"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		logger.Error().Err(err).Msg("failed to decode create project request")
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Call API service
	resp, err := s.api.CreateProject(r.Context(), &api.CreateProjectRequest{
		ProjectID: req.ProjectID,
	})

	if err != nil {
		logger.Error().Err(err).Msg("create project failed")
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
	
	logger.Info().Msg("create project request completed")
}

// handleHealth handles GET /health
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	health := s.api.HealthCheck()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(health)
}

// handleReady handles GET /ready
func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	// Check if API service is ready
	health := s.api.HealthCheck()
	if !health.Healthy {
		http.Error(w, "Service not ready", http.StatusServiceUnavailable)
		return
	}
	
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("OK"))
}

// handleMetrics handles GET /metrics (Prometheus format)
func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	apiMetrics := s.api.GetMetrics()
	walMetrics := s.api.GetWALMetrics()

	w.Header().Set("Content-Type", "text/plain")
	fmt.Fprintf(w, "# HELP events_appended_total Total number of events appended\n")
	fmt.Fprintf(w, "# TYPE events_appended_total counter\n")
	fmt.Fprintf(w, "events_appended_total %d\n", walMetrics.EventsAppended)
	
	fmt.Fprintf(w, "# HELP wal_bytes_written_total Total bytes written to WAL\n")
	fmt.Fprintf(w, "# TYPE wal_bytes_written_total counter\n")
	fmt.Fprintf(w, "wal_bytes_written_total %d\n", walMetrics.BytesWritten)
	
	fmt.Fprintf(w, "# HELP wal_syncs_performed_total Total fsync operations\n")
	fmt.Fprintf(w, "# TYPE wal_syncs_performed_total counter\n")
	fmt.Fprintf(w, "wal_syncs_performed_total %d\n", walMetrics.SyncsPerformed)
	
	fmt.Fprintf(w, "# HELP api_append_requests_total Total append requests\n")
	fmt.Fprintf(w, "# TYPE api_append_requests_total counter\n")
	fmt.Fprintf(w, "api_append_requests_total %d\n", apiMetrics.AppendRequests)
	
	fmt.Fprintf(w, "# HELP api_read_requests_total Total read requests\n")
	fmt.Fprintf(w, "# TYPE api_read_requests_total counter\n")
	fmt.Fprintf(w, "api_read_requests_total %d\n", apiMetrics.ReadRequests)
	
	fmt.Fprintf(w, "# HELP api_replay_requests_total Total replay requests\n")
	fmt.Fprintf(w, "# TYPE api_replay_requests_total counter\n")
	fmt.Fprintf(w, "api_replay_requests_total %d\n", apiMetrics.ReplayRequests)
}

// generateCorrelationID generates a unique correlation ID for request tracing.
func generateCorrelationID() string {
	// Use UUID for guaranteed uniqueness
	return uuid.New().String()
}