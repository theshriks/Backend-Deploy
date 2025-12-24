// Package config provides environment-based configuration for ShrikDB.
// Supports dev, staging, and production environments with secure defaults.
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"shrikdb/pkg/api"
	"shrikdb/pkg/server"
	"shrikdb/pkg/wal"

	"github.com/rs/zerolog"
)

// Config holds all ShrikDB configuration.
type Config struct {
	Environment string
	DataDir     string
	LogLevel    string
	Server      server.Config
	API         api.Config
	WAL         wal.Config
}

// Load loads configuration from environment variables with secure defaults.
func Load() (*Config, error) {
	env := getEnv("SHRIKDB_ENV", "development")
	
	// Validate environment
	if !isValidEnvironment(env) {
		return nil, fmt.Errorf("invalid environment: %s (must be development, staging, or production)", env)
	}

	dataDir := getEnv("SHRIKDB_DATA_DIR", getDefaultDataDir(env))
	logLevel := getEnv("SHRIKDB_LOG_LEVEL", getDefaultLogLevel(env))

	// Server configuration
	serverConfig := server.Config{
		Port:         getEnvInt("SHRIKDB_PORT", 8080),
		ReadTimeout:  getEnvDuration("SHRIKDB_READ_TIMEOUT", 10*time.Second),
		WriteTimeout: getEnvDuration("SHRIKDB_WRITE_TIMEOUT", 10*time.Second),
		IdleTimeout:  getEnvDuration("SHRIKDB_IDLE_TIMEOUT", 60*time.Second),
		RateLimit:    getEnvInt("SHRIKDB_RATE_LIMIT", getRateLimitDefault(env)),
	}

	// WAL configuration
	walConfig := wal.Config{
		DataDir:      dataDir,
		SyncMode:     getEnv("SHRIKDB_SYNC_MODE", getSyncModeDefault(env)),
		BatchSize:    getEnvInt("SHRIKDB_BATCH_SIZE", 100),
		BatchTimeout: getEnvDuration("SHRIKDB_BATCH_TIMEOUT", 100*time.Millisecond),
		MaxFileSize:  getEnvInt64("SHRIKDB_MAX_FILE_SIZE", 100*1024*1024), // 100MB
	}

	// API configuration
	apiConfig := api.Config{
		DataDir: dataDir,
		WAL:     walConfig,
	}

	config := &Config{
		Environment: env,
		DataDir:     dataDir,
		LogLevel:    logLevel,
		Server:      serverConfig,
		API:         apiConfig,
		WAL:         walConfig,
	}

	// Validate configuration
	if err := config.Validate(); err != nil {
		return nil, fmt.Errorf("configuration validation failed: %w", err)
	}

	return config, nil
}

// Validate performs comprehensive configuration validation.
func (c *Config) Validate() error {
	// Validate environment
	if !isValidEnvironment(c.Environment) {
		return fmt.Errorf("invalid environment: %s", c.Environment)
	}

	// Validate data directory
	if c.DataDir == "" {
		return fmt.Errorf("data directory cannot be empty")
	}

	// Validate log level
	if _, err := zerolog.ParseLevel(c.LogLevel); err != nil {
		return fmt.Errorf("invalid log level: %s", c.LogLevel)
	}

	// Validate server config
	if c.Server.Port <= 0 || c.Server.Port > 65535 {
		return fmt.Errorf("invalid port: %d", c.Server.Port)
	}

	if c.Server.RateLimit <= 0 {
		return fmt.Errorf("rate limit must be positive: %d", c.Server.RateLimit)
	}

	// Validate WAL config
	if !isValidSyncMode(c.WAL.SyncMode) {
		return fmt.Errorf("invalid sync mode: %s", c.WAL.SyncMode)
	}

	if c.WAL.BatchSize <= 0 {
		return fmt.Errorf("batch size must be positive: %d", c.WAL.BatchSize)
	}

	if c.WAL.MaxFileSize <= 0 {
		return fmt.Errorf("max file size must be positive: %d", c.WAL.MaxFileSize)
	}

	// Security validation - ensure no secrets in config
	if err := c.validateNoSecrets(); err != nil {
		return err
	}

	return nil
}

// validateNoSecrets ensures no hardcoded secrets are present.
func (c *Config) validateNoSecrets() error {
	// Check for common secret patterns in string fields
	secretPatterns := []string{
		"password", "secret", "key", "token", "credential",
		"api_key", "private_key", "access_token", "auth_token",
	}

	configStr := fmt.Sprintf("%+v", c)
	lowerConfig := strings.ToLower(configStr)

	for _, pattern := range secretPatterns {
		if strings.Contains(lowerConfig, pattern+"=") || strings.Contains(lowerConfig, pattern+":") {
			return fmt.Errorf("potential secret detected in configuration: %s", pattern)
		}
	}

	return nil
}

// IsProduction returns true if running in production environment.
func (c *Config) IsProduction() bool {
	return c.Environment == "production"
}

// IsDevelopment returns true if running in development environment.
func (c *Config) IsDevelopment() bool {
	return c.Environment == "development"
}

// GetLogger creates a configured logger based on environment.
func (c *Config) GetLogger() zerolog.Logger {
	level, _ := zerolog.ParseLevel(c.LogLevel)

	if c.IsDevelopment() {
		// Human-readable console output for development
		return zerolog.New(zerolog.ConsoleWriter{
			Out:        os.Stdout,
			TimeFormat: time.RFC3339,
		}).Level(level).With().Timestamp().Logger()
	}

	// Structured JSON output for production
	return zerolog.New(os.Stdout).
		Level(level).
		With().
		Timestamp().
		Str("service", "shrikdb").
		Str("version", "1.0.0-phase1a").
		Str("environment", c.Environment).
		Logger()
}

// Helper functions

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		if intValue, err := strconv.Atoi(value); err == nil {
			return intValue
		}
	}
	return defaultValue
}

func getEnvInt64(key string, defaultValue int64) int64 {
	if value := os.Getenv(key); value != "" {
		if intValue, err := strconv.ParseInt(value, 10, 64); err == nil {
			return intValue
		}
	}
	return defaultValue
}

func getEnvDuration(key string, defaultValue time.Duration) time.Duration {
	if value := os.Getenv(key); value != "" {
		if duration, err := time.ParseDuration(value); err == nil {
			return duration
		}
	}
	return defaultValue
}

func isValidEnvironment(env string) bool {
	validEnvs := []string{"development", "staging", "production"}
	for _, valid := range validEnvs {
		if env == valid {
			return true
		}
	}
	return false
}

func isValidSyncMode(mode string) bool {
	validModes := []string{"always", "batch", "none"}
	for _, valid := range validModes {
		if mode == valid {
			return true
		}
	}
	return false
}

func getDefaultDataDir(env string) string {
	switch env {
	case "production":
		return "/var/lib/shrikdb"
	case "staging":
		return "/tmp/shrikdb-staging"
	default:
		return "./data"
	}
}

func getDefaultLogLevel(env string) string {
	switch env {
	case "production":
		return "info"
	case "staging":
		return "debug"
	default:
		return "debug"
	}
}

func getSyncModeDefault(env string) string {
	switch env {
	case "production":
		return "always" // Maximum durability in production
	case "staging":
		return "batch"  // Balanced for staging
	default:
		return "always" // Safe default for development
	}
}

func getRateLimitDefault(env string) int {
	switch env {
	case "production":
		return 1000 // Higher limit for production
	case "staging":
		return 500  // Medium limit for staging
	default:
		return 100  // Conservative limit for development
	}
}

// LoadFromFile loads configuration from a JSON file (for testing).
func LoadFromFile(filename string) (*Config, error) {
	data, err := os.ReadFile(filename)
	if err != nil {
		return nil, fmt.Errorf("failed to read config file: %w", err)
	}

	var config Config
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("failed to parse config file: %w", err)
	}

	if err := config.Validate(); err != nil {
		return nil, fmt.Errorf("invalid configuration: %w", err)
	}

	return &config, nil
}

// SaveToFile saves configuration to a JSON file (for testing).
func (c *Config) SaveToFile(filename string) error {
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	if err := os.WriteFile(filename, data, 0644); err != nil {
		return fmt.Errorf("failed to write config file: %w", err)
	}

	return nil
}