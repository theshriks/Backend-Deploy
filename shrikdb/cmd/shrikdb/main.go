// ShrikDB Phase 1A - The Spine
// Immutable, append-only event log core
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"shrikdb/pkg/api"
	"shrikdb/pkg/config"
	"shrikdb/pkg/server"

	"github.com/rs/zerolog"
)

func main() {
	// Parse flags (for backward compatibility)
	demo := flag.Bool("demo", false, "Run demo mode")
	configFile := flag.String("config", "", "Configuration file path (optional)")
	flag.Parse()

	// Load configuration
	var cfg *config.Config
	var err error

	if *configFile != "" {
		cfg, err = config.LoadFromFile(*configFile)
	} else {
		cfg, err = config.Load()
	}

	if err != nil {
		fmt.Fprintf(os.Stderr, "Configuration error: %v\n", err)
		os.Exit(1)
	}

	// Setup logger
	logger := cfg.GetLogger()

	logger.Info().
		Str("version", "1.0.0-phase1a").
		Str("environment", cfg.Environment).
		Str("data_dir", cfg.DataDir).
		Str("sync_mode", cfg.WAL.SyncMode).
		Int("port", cfg.Server.Port).
		Msg("ShrikDB starting")

	// Initialize service
	svc, err := api.NewService(cfg.API, logger)
	if err != nil {
		logger.Fatal().Err(err).Msg("Failed to initialize service")
	}
	defer svc.Close()

	if *demo {
		runDemo(svc, logger)
		return
	}

	// Start HTTP server
	httpServer := server.New(svc, cfg.Server, logger)
	
	// Start server in goroutine
	go func() {
		if err := httpServer.Start(); err != nil && err != http.ErrServerClosed {
			logger.Fatal().Err(err).Msg("HTTP server failed")
		}
	}()

	logger.Info().Int("port", cfg.Server.Port).Msg("ShrikDB ready")

	// Wait for shutdown signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	logger.Info().Msg("Shutting down...")

	// Graceful shutdown
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := httpServer.Stop(ctx); err != nil {
		logger.Error().Err(err).Msg("HTTP server shutdown error")
	}
}

func runDemo(svc *api.Service, logger zerolog.Logger) {
	ctx := context.Background()

	logger.Info().Msg("=== ShrikDB Phase 1A Demo ===")

	// 1. Create a project
	logger.Info().Msg("Step 1: Creating project...")
	createResp, err := svc.CreateProject(ctx, &api.CreateProjectRequest{
		ProjectID: "demo-project",
	})
	if err != nil {
		logger.Error().Err(err).Msg("Failed to create project")
		return
	}
	logger.Info().
		Str("project_id", createResp.ProjectID).
		Str("client_id", createResp.ClientID).
		Msg("Project created (client_key hidden for security)")

	// 2. Append events
	logger.Info().Msg("Step 2: Appending events...")
	events := []struct {
		eventType string
		payload   string
	}{
		{"user.created", `{"user_id": "u1", "email": "alice@example.com"}`},
		{"user.updated", `{"user_id": "u1", "name": "Alice Smith"}`},
		{"order.created", `{"order_id": "o1", "user_id": "u1", "total": 99.99}`},
		{"order.paid", `{"order_id": "o1", "payment_method": "card"}`},
		{"user.created", `{"user_id": "u2", "email": "bob@example.com"}`},
	}

	for _, e := range events {
		resp, err := svc.AppendEvent(ctx, &api.AppendEventRequest{
			ClientID:  createResp.ClientID,
			ClientKey: createResp.ClientKey,
			EventType: e.eventType,
			Payload:   json.RawMessage(e.payload),
		})
		if err != nil {
			logger.Error().Err(err).Msg("Failed to append event")
			continue
		}
		logger.Info().
			Str("event_id", resp.Event.EventID).
			Uint64("sequence", resp.Event.SequenceNumber).
			Str("type", resp.Event.EventType).
			Str("hash", resp.Event.PayloadHash[:16]+"...").
			Msg("Event appended")
	}

	// 3. Read events
	logger.Info().Msg("Step 3: Reading all events...")
	readResp, err := svc.ReadEvents(ctx, &api.ReadEventsRequest{
		ClientID:     createResp.ClientID,
		ClientKey:    createResp.ClientKey,
		FromSequence: 0,
	})
	if err != nil {
		logger.Error().Err(err).Msg("Failed to read events")
		return
	}
	logger.Info().Int("count", readResp.Count).Msg("Events read")

	// 4. Verify integrity via replay
	logger.Info().Msg("Step 4: Verifying integrity via replay...")
	replayResp, err := svc.Replay(ctx, &api.ReplayRequest{
		ClientID:   createResp.ClientID,
		ClientKey:  createResp.ClientKey,
		VerifyOnly: true,
	})
	if err != nil {
		logger.Error().Err(err).Msg("Replay failed")
		return
	}
	logger.Info().
		Uint64("events_verified", replayResp.Progress.ProcessedEvents).
		Dur("duration", time.Since(replayResp.Progress.StartTime)).
		Msg("Integrity verified")

	// 5. Show metrics
	logger.Info().Msg("Step 5: Metrics...")
	apiMetrics := svc.GetMetrics()
	walMetrics := svc.GetWALMetrics()
	logger.Info().
		Uint64("api_appends", apiMetrics.AppendRequests).
		Uint64("api_reads", apiMetrics.ReadRequests).
		Uint64("wal_events", walMetrics.EventsAppended).
		Uint64("wal_bytes", walMetrics.BytesWritten).
		Uint64("wal_syncs", walMetrics.SyncsPerformed).
		Msg("Metrics")

	// 6. Health check
	health := svc.HealthCheck()
	logger.Info().
		Bool("healthy", health.Healthy).
		Str("wal_status", health.WALStatus).
		Str("uptime", health.Uptime).
		Msg("Health check")

	logger.Info().Msg("=== Demo Complete ===")
	fmt.Println("\nCheck ./data/projects/demo-project/events.wal for the raw event log")
}
