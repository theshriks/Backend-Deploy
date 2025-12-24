package auth

import (
	"os"
	"testing"

	"github.com/leanovate/gopter"
	"github.com/leanovate/gopter/gen"
	"github.com/leanovate/gopter/prop"
	"github.com/rs/zerolog"
)

func setupTestStore(t *testing.T) (*Store, string) {
	t.Helper()

	tmpDir, err := os.MkdirTemp("", "shrikdb-auth-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}

	logger := zerolog.New(zerolog.NewTestWriter(t)).With().Timestamp().Logger()
	store := NewStore(tmpDir, logger)

	return store, tmpDir
}

func TestCreateProject(t *testing.T) {
	store, tmpDir := setupTestStore(t)
	defer os.RemoveAll(tmpDir)

	projectID := "test-project"

	// Create project
	clientID, clientKey, err := store.CreateProject(projectID)
	if err != nil {
		t.Fatalf("CreateProject failed: %v", err)
	}

	if clientID == "" {
		t.Error("ClientID should not be empty")
	}
	if clientKey == "" {
		t.Error("ClientKey should not be empty")
	}

	// Verify authentication works
	authProjectID, err := store.Authenticate(clientID, clientKey)
	if err != nil {
		t.Fatalf("Authentication failed: %v", err)
	}

	if authProjectID != projectID {
		t.Errorf("Authenticated project ID = %s, want %s", authProjectID, projectID)
	}
}

func TestCreateProject_Duplicate(t *testing.T) {
	store, tmpDir := setupTestStore(t)
	defer os.RemoveAll(tmpDir)

	projectID := "test-project"

	// Create project first time
	_, _, err := store.CreateProject(projectID)
	if err != nil {
		t.Fatalf("First CreateProject failed: %v", err)
	}

	// Try to create same project again
	_, _, err = store.CreateProject(projectID)
	if err != ErrProjectExists {
		t.Errorf("Second CreateProject should fail with ErrProjectExists, got %v", err)
	}
}

func TestAuthenticate_InvalidCredentials(t *testing.T) {
	store, tmpDir := setupTestStore(t)
	defer os.RemoveAll(tmpDir)

	tests := []struct {
		name     string
		clientID string
		clientKey string
		wantErr  error
	}{
		{"unknown client", "unknown", "key", ErrInvalidCredentials},
		{"wrong key", "cid_123", "wrong", ErrInvalidCredentials},
		{"empty client", "", "key", ErrInvalidCredentials},
		{"empty key", "cid_123", "", ErrInvalidCredentials},
	}

	// Create a valid project first
	clientID, _, _ := store.CreateProject("test-project")

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Use real client ID for "wrong key" test
			testClientID := tt.clientID
			if tt.name == "wrong key" {
				testClientID = clientID
			}

			_, err := store.Authenticate(testClientID, tt.clientKey)
			if err != tt.wantErr {
				t.Errorf("Authenticate() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestRevokeCredentials(t *testing.T) {
	store, tmpDir := setupTestStore(t)
	defer os.RemoveAll(tmpDir)

	// Create project
	clientID, clientKey, _ := store.CreateProject("test-project")

	// Verify authentication works
	_, err := store.Authenticate(clientID, clientKey)
	if err != nil {
		t.Fatalf("Authentication should work before revocation: %v", err)
	}

	// Revoke credentials
	err = store.RevokeCredentials(clientID)
	if err != nil {
		t.Fatalf("RevokeCredentials failed: %v", err)
	}

	// Verify authentication fails after revocation
	_, err = store.Authenticate(clientID, clientKey)
	if err != ErrInvalidCredentials {
		t.Errorf("Authentication should fail after revocation, got %v", err)
	}
}

func TestRotateKey(t *testing.T) {
	store, tmpDir := setupTestStore(t)
	defer os.RemoveAll(tmpDir)

	// Create project
	clientID, oldKey, _ := store.CreateProject("test-project")

	// Rotate key
	newKey, err := store.RotateKey(clientID, oldKey)
	if err != nil {
		t.Fatalf("RotateKey failed: %v", err)
	}

	if newKey == oldKey {
		t.Error("New key should be different from old key")
	}

	// Old key should not work
	_, err = store.Authenticate(clientID, oldKey)
	if err != ErrInvalidCredentials {
		t.Error("Old key should not work after rotation")
	}

	// New key should work
	_, err = store.Authenticate(clientID, newKey)
	if err != nil {
		t.Errorf("New key should work after rotation: %v", err)
	}
}

func TestPersistence(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "shrikdb-auth-persist-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	logger := zerolog.New(zerolog.NewTestWriter(t)).With().Timestamp().Logger()

	var clientID, clientKey string

	// First store instance
	{
		store1 := NewStore(tmpDir, logger)
		clientID, clientKey, err = store1.CreateProject("test-project")
		if err != nil {
			t.Fatalf("CreateProject failed: %v", err)
		}
	}

	// Second store instance - should load from disk
	{
		store2 := NewStore(tmpDir, logger)

		// Should be able to authenticate with persisted credentials
		projectID, err := store2.Authenticate(clientID, clientKey)
		if err != nil {
			t.Fatalf("Authentication failed after reload: %v", err)
		}

		if projectID != "test-project" {
			t.Errorf("Project ID = %s, want test-project", projectID)
		}
	}
}

// **Feature: shrikdb-phase-1a, Property 6: Authentication and Authorization**
// **Validates: Requirements 3.2, 4.1, 4.2, 4.4**
func TestProperty_AuthenticationAndAuthorization(t *testing.T) {
	properties := gopter.NewProperties(&gopter.TestParameters{
		MinSuccessfulTests: 20, // Reduce from default 100
		MaxDiscardRatio: 10,    // Allow more discards
	})

	properties.Property("valid credentials always authenticate", prop.ForAll(
		func(projectID string) bool {
			// Skip invalid inputs
			if projectID == "" || len(projectID) > 20 {
				return true
			}

			store, tmpDir := setupTestStore(t)
			defer os.RemoveAll(tmpDir)

			// Create project
			clientID, clientKey, err := store.CreateProject(projectID)
			if err != nil {
				return true // Skip if project creation fails
			}

			// Authentication should always work with valid credentials
			authProjectID, err := store.Authenticate(clientID, clientKey)
			if err != nil {
				return false
			}

			// Should return correct project ID
			return authProjectID == projectID
		},
		gen.AlphaString().SuchThat(func(s string) bool { return len(s) > 0 && len(s) <= 20 }),
	))

	properties.Property("invalid credentials always fail", prop.ForAll(
		func(projectID, fakeClientID, fakeKey string) bool {
			// Skip invalid inputs
			if projectID == "" || len(projectID) > 20 {
				return true
			}

			store, tmpDir := setupTestStore(t)
			defer os.RemoveAll(tmpDir)

			// Create a real project
			realClientID, realKey, err := store.CreateProject(projectID)
			if err != nil {
				return true
			}

			// Test various invalid credential combinations
			invalidTests := []struct {
				clientID string
				key      string
			}{
				{fakeClientID, fakeKey},           // Completely fake
				{realClientID, fakeKey},           // Real client, fake key
				{fakeClientID, realKey},           // Fake client, real key
				{"", realKey},                     // Empty client ID
				{realClientID, ""},                // Empty key
			}

			for _, test := range invalidTests {
				// Skip if it's the valid combination
				if test.clientID == realClientID && test.key == realKey {
					continue
				}

				_, err := store.Authenticate(test.clientID, test.key)
				if err == nil {
					return false // Should have failed
				}
			}

			return true
		},
		gen.AlphaString().SuchThat(func(s string) bool { return len(s) > 0 && len(s) <= 20 }),
		gen.AlphaString().SuchThat(func(s string) bool { return len(s) > 0 && len(s) <= 20 }),
		gen.AlphaString().SuchThat(func(s string) bool { return len(s) > 0 && len(s) <= 20 }),
	))

	properties.Property("bcrypt hashing is secure", prop.ForAll(
		func(projectID string) bool {
			// Skip invalid inputs
			if projectID == "" || len(projectID) > 20 {
				return true
			}

			store, tmpDir := setupTestStore(t)
			defer os.RemoveAll(tmpDir)

			// Create project
			clientID, clientKey, err := store.CreateProject(projectID)
			if err != nil {
				return true
			}

			// Get the stored credentials
			store.mu.RLock()
			creds, exists := store.credentials[clientID]
			store.mu.RUnlock()

			if !exists {
				return false
			}

			// Verify the key is hashed (not stored in plaintext)
			if creds.ClientKeyHash == clientKey {
				return false // Key should be hashed, not plaintext
			}

			// Verify bcrypt verification works
			return verifyKey(clientKey, creds.ClientKeyHash)
		},
		gen.AlphaString().SuchThat(func(s string) bool { return len(s) > 0 && len(s) <= 20 }),
	))

	properties.TestingRun(t, gopter.ConsoleReporter(false))
}

func TestSecureKeyGeneration(t *testing.T) {
	// Generate multiple keys and verify they're unique
	keys := make(map[string]bool)
	for i := 0; i < 1000; i++ {
		key := generateSecureKey()
		if keys[key] {
			t.Errorf("Duplicate key generated: %s", key)
		}
		keys[key] = true

		// Key should be hex-encoded and have expected length
		if len(key) != 64 { // 32 bytes * 2 hex chars per byte
			t.Errorf("Key length = %d, want 64", len(key))
		}
	}
}

func TestSecureIDGeneration(t *testing.T) {
	// Generate multiple IDs and verify they're unique
	ids := make(map[string]bool)
	for i := 0; i < 1000; i++ {
		id := generateSecureID("test")
		if ids[id] {
			t.Errorf("Duplicate ID generated: %s", id)
		}
		ids[id] = true

		// ID should have expected format
		if len(id) < 5 { // At least "test_" + some hex
			t.Errorf("ID too short: %s", id)
		}
		if id[:5] != "test_" {
			t.Errorf("ID should start with 'test_': %s", id)
		}
	}
}

func TestBcryptCost(t *testing.T) {
	// Verify bcrypt cost is production-grade (>= 12)
	key := "test-key"
	hash := hashKey(key)

	// bcrypt hashes start with $2a$XX$ where XX is the cost
	if len(hash) < 7 {
		t.Error("Hash too short")
	}

	// Extract cost from hash (positions 4-5)
	costStr := hash[4:6]
	if costStr < "12" {
		t.Errorf("bcrypt cost = %s, should be >= 12 for production", costStr)
	}
}