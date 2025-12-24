package config

import (
	"os"
	"testing"
	"time"

	"github.com/leanovate/gopter"
	"github.com/leanovate/gopter/gen"
	"github.com/leanovate/gopter/prop"
	"github.com/rs/zerolog"
	"shrikdb/pkg/server"
	"shrikdb/pkg/wal"
)

func TestLoad_Development(t *testing.T) {
	// Clear environment
	os.Clearenv()
	os.Setenv("SHRIKDB_ENV", "development")

	config, err := Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	if config.Environment != "development" {
		t.Errorf("Environment = %s, want development", config.Environment)
	}

	if config.DataDir != "./data" {
		t.Errorf("DataDir = %s, want ./data", config.DataDir)
	}

	if config.LogLevel != "debug" {
		t.Errorf("LogLevel = %s, want debug", config.LogLevel)
	}

	if config.WAL.SyncMode != "always" {
		t.Errorf("SyncMode = %s, want always", config.WAL.SyncMode)
	}
}

func TestLoad_Production(t *testing.T) {
	// Clear environment
	os.Clearenv()
	os.Setenv("SHRIKDB_ENV", "production")

	config, err := Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	if config.Environment != "production" {
		t.Errorf("Environment = %s, want production", config.Environment)
	}

	if config.DataDir != "/var/lib/shrikdb" {
		t.Errorf("DataDir = %s, want /var/lib/shrikdb", config.DataDir)
	}

	if config.LogLevel != "info" {
		t.Errorf("LogLevel = %s, want info", config.LogLevel)
	}

	if config.Server.RateLimit != 1000 {
		t.Errorf("RateLimit = %d, want 1000", config.Server.RateLimit)
	}
}

func TestLoad_CustomEnvironmentVariables(t *testing.T) {
	// Clear environment
	os.Clearenv()
	
	// Set custom values
	os.Setenv("SHRIKDB_ENV", "staging")
	os.Setenv("SHRIKDB_PORT", "9090")
	os.Setenv("SHRIKDB_DATA_DIR", "/custom/data")
	os.Setenv("SHRIKDB_LOG_LEVEL", "warn")
	os.Setenv("SHRIKDB_SYNC_MODE", "batch")
	os.Setenv("SHRIKDB_RATE_LIMIT", "200")

	config, err := Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	if config.Environment != "staging" {
		t.Errorf("Environment = %s, want staging", config.Environment)
	}

	if config.Server.Port != 9090 {
		t.Errorf("Port = %d, want 9090", config.Server.Port)
	}

	if config.DataDir != "/custom/data" {
		t.Errorf("DataDir = %s, want /custom/data", config.DataDir)
	}

	if config.LogLevel != "warn" {
		t.Errorf("LogLevel = %s, want warn", config.LogLevel)
	}

	if config.WAL.SyncMode != "batch" {
		t.Errorf("SyncMode = %s, want batch", config.WAL.SyncMode)
	}

	if config.Server.RateLimit != 200 {
		t.Errorf("RateLimit = %d, want 200", config.Server.RateLimit)
	}
}

func TestValidate_InvalidEnvironment(t *testing.T) {
	config := &Config{
		Environment: "invalid",
		DataDir:     "./data",
		LogLevel:    "info",
	}

	err := config.Validate()
	if err == nil {
		t.Error("Validate should fail with invalid environment")
	}
}

func TestValidate_InvalidPort(t *testing.T) {
	config := &Config{
		Environment: "development",
		DataDir:     "./data",
		LogLevel:    "info",
		Server: server.Config{
			Port: -1,
		},
	}

	err := config.Validate()
	if err == nil {
		t.Error("Validate should fail with invalid port")
	}
}

func TestValidate_InvalidLogLevel(t *testing.T) {
	config := &Config{
		Environment: "development",
		DataDir:     "./data",
		LogLevel:    "invalid",
	}

	err := config.Validate()
	if err == nil {
		t.Error("Validate should fail with invalid log level")
	}
}

func TestValidate_InvalidSyncMode(t *testing.T) {
	config := &Config{
		Environment: "development",
		DataDir:     "./data",
		LogLevel:    "info",
		WAL: wal.Config{
			SyncMode: "invalid",
		},
	}

	err := config.Validate()
	if err == nil {
		t.Error("Validate should fail with invalid sync mode")
	}
}

func TestValidateNoSecrets(t *testing.T) {
	// This test ensures no secrets are accidentally hardcoded
	config := &Config{
		Environment: "development",
		DataDir:     "./data",
		LogLevel:    "info",
	}

	err := config.validateNoSecrets()
	if err != nil {
		t.Errorf("validateNoSecrets failed: %v", err)
	}
}

func TestIsProduction(t *testing.T) {
	config := &Config{Environment: "production"}
	if !config.IsProduction() {
		t.Error("IsProduction should return true for production environment")
	}

	config.Environment = "development"
	if config.IsProduction() {
		t.Error("IsProduction should return false for development environment")
	}
}

func TestIsDevelopment(t *testing.T) {
	config := &Config{Environment: "development"}
	if !config.IsDevelopment() {
		t.Error("IsDevelopment should return true for development environment")
	}

	config.Environment = "production"
	if config.IsDevelopment() {
		t.Error("IsDevelopment should return false for production environment")
	}
}

func TestGetLogger(t *testing.T) {
	// Test development logger
	devConfig := &Config{
		Environment: "development",
		LogLevel:    "debug",
	}
	devLogger := devConfig.GetLogger()
	if devLogger.GetLevel() != zerolog.DebugLevel {
		t.Error("Development logger should have debug level")
	}

	// Test production logger
	prodConfig := &Config{
		Environment: "production",
		LogLevel:    "info",
	}
	prodLogger := prodConfig.GetLogger()
	if prodLogger.GetLevel() != zerolog.InfoLevel {
		t.Error("Production logger should have info level")
	}
}

func TestLoadFromFile(t *testing.T) {
	// Create temporary config file in temp directory (not Windows system directory)
	tmpFile, err := os.CreateTemp(os.TempDir(), "config-test-*.json")
	if err != nil {
		t.Fatalf("Failed to create temp file: %v", err)
	}
	defer os.Remove(tmpFile.Name())

	configJSON := `{
		"Environment": "staging",
		"DataDir": "/test/data",
		"LogLevel": "warn",
		"Server": {
			"Port": 8081,
			"ReadTimeout": 5000000000,
			"WriteTimeout": 5000000000,
			"IdleTimeout": 30000000000,
			"RateLimit": 150
		},
		"WAL": {
			"DataDir": "/test/data",
			"SyncMode": "batch",
			"BatchSize": 50,
			"BatchTimeout": 50000000,
			"MaxFileSize": 52428800
		}
	}`

	if _, err := tmpFile.WriteString(configJSON); err != nil {
		t.Fatalf("Failed to write config file: %v", err)
	}
	tmpFile.Close()

	config, err := LoadFromFile(tmpFile.Name())
	if err != nil {
		t.Fatalf("LoadFromFile failed: %v", err)
	}

	if config.Environment != "staging" {
		t.Errorf("Environment = %s, want staging", config.Environment)
	}

	if config.Server.Port != 8081 {
		t.Errorf("Port = %d, want 8081", config.Server.Port)
	}
}

func TestSaveToFile(t *testing.T) {
	config := &Config{
		Environment: "development",
		DataDir:     "./test-data",
		LogLevel:    "debug",
		Server: server.Config{
			Port:         8080,
			ReadTimeout:  10 * time.Second,
			WriteTimeout: 10 * time.Second,
			IdleTimeout:  60 * time.Second,
			RateLimit:    100,
		},
		WAL: wal.Config{
			DataDir:      "./test-data",
			SyncMode:     "always",
			BatchSize:    100,
			BatchTimeout: 100 * time.Millisecond,
			MaxFileSize:  100 * 1024 * 1024,
		},
	}

	tmpFile, err := os.CreateTemp(os.TempDir(), "config-save-test-*.json")
	if err != nil {
		t.Fatalf("Failed to create temp file: %v", err)
	}
	defer os.Remove(tmpFile.Name())
	tmpFile.Close()

	if err := config.SaveToFile(tmpFile.Name()); err != nil {
		t.Fatalf("SaveToFile failed: %v", err)
	}

	// Load it back and verify
	loadedConfig, err := LoadFromFile(tmpFile.Name())
	if err != nil {
		t.Fatalf("LoadFromFile failed: %v", err)
	}

	if loadedConfig.Environment != config.Environment {
		t.Errorf("Environment mismatch after save/load")
	}
}

// **Feature: shrikdb-phase-1a, Property 11: Configuration Security**
// **Validates: Requirements 9.1, 9.2, 9.3**
func TestProperty_ConfigurationSecurity(t *testing.T) {
	properties := gopter.NewProperties(nil)

	properties.Property("no secrets in configuration", prop.ForAll(
		func(env, dataDir, logLevel string) bool {
			// Skip invalid inputs
			if !isValidEnvironment(env) {
				return true
			}

			config := &Config{
				Environment: env,
				DataDir:     dataDir,
				LogLevel:    logLevel,
				Server: server.Config{
					Port:         8080,
					ReadTimeout:  10 * time.Second,
					WriteTimeout: 10 * time.Second,
					IdleTimeout:  60 * time.Second,
					RateLimit:    100,
				},
				WAL: wal.Config{
					DataDir:      dataDir,
					SyncMode:     "always",
					BatchSize:    100,
					BatchTimeout: 100 * time.Millisecond,
					MaxFileSize:  100 * 1024 * 1024,
				},
			}

			// Configuration should never contain secrets
			err := config.validateNoSecrets()
			return err == nil
		},
		gen.OneConstOf(gen.Const("development"), gen.Const("staging"), gen.Const("production")),
		gen.AlphaString().SuchThat(func(s string) bool { return len(s) > 0 && len(s) < 100 }),
		gen.OneConstOf(gen.Const("debug"), gen.Const("info"), gen.Const("warn"), gen.Const("error")),
	))

	properties.Property("environment-specific defaults are secure", prop.ForAll(
		func(env string) bool {
			// Skip invalid environments
			if !isValidEnvironment(env) {
				return true
			}

			// Clear environment variables
			oldEnv := os.Getenv("SHRIKDB_ENV")
			os.Setenv("SHRIKDB_ENV", env)
			defer func() {
				if oldEnv != "" {
					os.Setenv("SHRIKDB_ENV", oldEnv)
				} else {
					os.Unsetenv("SHRIKDB_ENV")
				}
			}()

			config, err := Load()
			if err != nil {
				return false
			}

			// Production should have secure defaults
			if env == "production" {
				return config.WAL.SyncMode == "always" && // Maximum durability
					config.LogLevel == "info" && // Not debug in production
					config.Server.RateLimit >= 1000 // Higher rate limit for production
			}

			// All environments should have valid configurations
			return config.Validate() == nil
		},
		gen.OneConstOf(gen.Const("development"), gen.Const("staging"), gen.Const("production")),
	))

	properties.Property("WAL directory is configurable", prop.ForAll(
		func(customDir string) bool {
			// Skip empty or invalid directories
			if customDir == "" || len(customDir) > 200 {
				return true
			}

			// Set custom data directory
			oldDir := os.Getenv("SHRIKDB_DATA_DIR")
			os.Setenv("SHRIKDB_DATA_DIR", customDir)
			defer func() {
				if oldDir != "" {
					os.Setenv("SHRIKDB_DATA_DIR", oldDir)
				} else {
					os.Unsetenv("SHRIKDB_DATA_DIR")
				}
			}()

			config, err := Load()
			if err != nil {
				return false
			}

			// Both main config and WAL config should use custom directory
			return config.DataDir == customDir && config.WAL.DataDir == customDir
		},
		gen.AlphaString().SuchThat(func(s string) bool { return len(s) > 0 && len(s) < 50 }),
	))

	properties.TestingRun(t, gopter.ConsoleReporter(false))
}

func TestEnvironmentVariableOverrides(t *testing.T) {
	// Test that environment variables properly override defaults
	tests := []struct {
		name     string
		envVar   string
		envValue string
		check    func(*Config) bool
	}{
		{
			name:     "port override",
			envVar:   "SHRIKDB_PORT",
			envValue: "9999",
			check:    func(c *Config) bool { return c.Server.Port == 9999 },
		},
		{
			name:     "log level override",
			envVar:   "SHRIKDB_LOG_LEVEL",
			envValue: "error",
			check:    func(c *Config) bool { return c.LogLevel == "error" },
		},
		{
			name:     "sync mode override",
			envVar:   "SHRIKDB_SYNC_MODE",
			envValue: "none",
			check:    func(c *Config) bool { return c.WAL.SyncMode == "none" },
		},
		{
			name:     "rate limit override",
			envVar:   "SHRIKDB_RATE_LIMIT",
			envValue: "500",
			check:    func(c *Config) bool { return c.Server.RateLimit == 500 },
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Clear environment
			os.Clearenv()
			os.Setenv("SHRIKDB_ENV", "development")
			os.Setenv(tt.envVar, tt.envValue)

			config, err := Load()
			if err != nil {
				t.Fatalf("Load failed: %v", err)
			}

			if !tt.check(config) {
				t.Errorf("Environment variable %s=%s was not applied correctly", tt.envVar, tt.envValue)
			}
		})
	}
}
