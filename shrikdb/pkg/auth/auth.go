// Package auth implements project-level authentication and isolation for ShrikDB.
// This is basic auth for Phase 1A - full RBAC comes later.
//
// Security model:
// - Each project has a client_id and client_key
// - Keys are stored hashed (bcrypt)
// - All operations require valid credentials
// - No secrets leak to frontend
// - Server-side trust only
package auth

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
	"github.com/rs/zerolog"
)

// Auth errors
var (
	ErrInvalidCredentials = errors.New("invalid client credentials")
	ErrProjectNotFound    = errors.New("project not found")
	ErrProjectExists      = errors.New("project already exists")
	ErrKeyExpired         = errors.New("client key has expired")
)

// Credentials represents a project's authentication credentials.
type Credentials struct {
	ClientID     string    `json:"client_id"`
	ClientKeyHash string   `json:"client_key_hash"` // Never store plaintext
	ProjectID    string    `json:"project_id"`
	CreatedAt    time.Time `json:"created_at"`
	ExpiresAt    *time.Time `json:"expires_at,omitempty"` // nil = never expires
	Revoked      bool      `json:"revoked"`
}

// Store manages project credentials.
// In production, this would be backed by a secure database.
// For Phase 1A, we use in-memory with file persistence.
type Store struct {
	mu          sync.RWMutex
	credentials map[string]*Credentials // clientID -> credentials
	projects    map[string]string       // projectID -> clientID
	logger      zerolog.Logger
	dataDir     string                  // Directory for persistence
}

// NewStore creates a new auth store.
func NewStore(dataDir string, logger zerolog.Logger) *Store {
	s := &Store{
		credentials: make(map[string]*Credentials),
		projects:    make(map[string]string),
		logger:      logger.With().Str("component", "auth").Logger(),
		dataDir:     dataDir,
	}
	
	// Load existing credentials from disk
	if err := s.loadFromDisk(); err != nil {
		logger.Warn().Err(err).Msg("failed to load credentials from disk, starting fresh")
	}
	
	return s
}

// CreateProject creates a new project with credentials.
// Returns the plaintext client key (only shown once).
func (s *Store) CreateProject(projectID string) (clientID, clientKey string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Check if project exists
	if _, exists := s.projects[projectID]; exists {
		return "", "", ErrProjectExists
	}

	// Generate credentials
	clientID = generateSecureID("cid")
	clientKey = generateSecureKey()
	keyHash := hashKey(clientKey)

	creds := &Credentials{
		ClientID:      clientID,
		ClientKeyHash: keyHash,
		ProjectID:     projectID,
		CreatedAt:     time.Now().UTC(),
	}

	s.credentials[clientID] = creds
	s.projects[projectID] = clientID

	s.logger.Info().
		Str("project_id", projectID).
		Str("client_id", clientID).
		Msg("project created")
	
	// Persist to disk (without holding the lock)
	go func() {
		if err := s.saveToDisk(); err != nil {
			s.logger.Error().Err(err).Msg("failed to persist credentials")
		}
	}()

	return clientID, clientKey, nil
}

// Authenticate validates credentials and returns the project ID.
func (s *Store) Authenticate(clientID, clientKey string) (string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	creds, exists := s.credentials[clientID]
	if !exists {
		s.logger.Warn().
			Str("client_id", clientID).
			Msg("authentication failed: unknown client")
		return "", ErrInvalidCredentials
	}

	if creds.Revoked {
		s.logger.Warn().
			Str("client_id", clientID).
			Msg("authentication failed: credentials revoked")
		return "", ErrInvalidCredentials
	}

	if creds.ExpiresAt != nil && time.Now().After(*creds.ExpiresAt) {
		s.logger.Warn().
			Str("client_id", clientID).
			Msg("authentication failed: credentials expired")
		return "", ErrKeyExpired
	}

	// Constant-time comparison to prevent timing attacks
	if !verifyKey(clientKey, creds.ClientKeyHash) {
		s.logger.Warn().
			Str("client_id", clientID).
			Msg("authentication failed: invalid key")
		return "", ErrInvalidCredentials
	}

	s.logger.Debug().
		Str("client_id", clientID).
		Str("project_id", creds.ProjectID).
		Msg("authentication successful")

	return creds.ProjectID, nil
}

// RevokeCredentials revokes a client's credentials.
func (s *Store) RevokeCredentials(clientID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	creds, exists := s.credentials[clientID]
	if !exists {
		return ErrProjectNotFound
	}

	creds.Revoked = true

	s.logger.Info().
		Str("client_id", clientID).
		Str("project_id", creds.ProjectID).
		Msg("credentials revoked")

	return nil
}

// RotateKey generates a new key for existing credentials.
// Returns the new plaintext key (only shown once).
func (s *Store) RotateKey(clientID, currentKey string) (string, error) {
	// First authenticate with current key
	projectID, err := s.Authenticate(clientID, currentKey)
	if err != nil {
		return "", err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	creds := s.credentials[clientID]
	newKey := generateSecureKey()
	creds.ClientKeyHash = hashKey(newKey)

	s.logger.Info().
		Str("client_id", clientID).
		Str("project_id", projectID).
		Msg("key rotated")

	return newKey, nil
}

// GetProjectID returns the project ID for a client.
func (s *Store) GetProjectID(clientID string) (string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	creds, exists := s.credentials[clientID]
	if !exists {
		return "", ErrProjectNotFound
	}

	return creds.ProjectID, nil
}

// ProjectExists checks if a project exists.
func (s *Store) ProjectExists(projectID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, exists := s.projects[projectID]
	return exists
}


// generateSecureID creates a prefixed secure random ID.
func generateSecureID(prefix string) string {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		panic(fmt.Sprintf("failed to generate secure ID: %v", err))
	}
	return fmt.Sprintf("%s_%s", prefix, hex.EncodeToString(bytes))
}

// generateSecureKey creates a secure random key.
func generateSecureKey() string {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		panic(fmt.Sprintf("failed to generate secure key: %v", err))
	}
	return hex.EncodeToString(bytes)
}

// hashKey creates a production-grade hash of the key for storage.
// Uses bcrypt with cost 12 for production security.
func hashKey(key string) string {
	hash, err := bcrypt.GenerateFromPassword([]byte(key), 12)
	if err != nil {
		panic(fmt.Sprintf("failed to hash key: %v", err))
	}
	return string(hash)
}

// verifyKey checks if a key matches a bcrypt hash.
func verifyKey(key, hash string) bool {
	err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(key))
	return err == nil
}

// Middleware provides authentication middleware for the API.
type Middleware struct {
	store *Store
}

// NewMiddleware creates auth middleware.
func NewMiddleware(store *Store) *Middleware {
	return &Middleware{store: store}
}

// AuthContext holds authenticated request context.
type AuthContext struct {
	ClientID  string
	ProjectID string
}

// Validate validates credentials and returns auth context.
func (m *Middleware) Validate(clientID, clientKey string) (*AuthContext, error) {
	projectID, err := m.store.Authenticate(clientID, clientKey)
	if err != nil {
		return nil, err
	}

	return &AuthContext{
		ClientID:  clientID,
		ProjectID: projectID,
	}, nil
}

// Export/Import for persistence
type ExportedCredentials struct {
	Credentials []*Credentials `json:"credentials"`
}

func (s *Store) Export() *ExportedCredentials {
	s.mu.RLock()
	defer s.mu.RUnlock()

	creds := make([]*Credentials, 0, len(s.credentials))
	for _, c := range s.credentials {
		creds = append(creds, c)
	}

	return &ExportedCredentials{Credentials: creds}
}

func (s *Store) Import(data *ExportedCredentials) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, c := range data.Credentials {
		s.credentials[c.ClientID] = c
		s.projects[c.ProjectID] = c.ClientID
	}

	s.logger.Info().
		Int("imported", len(data.Credentials)).
		Msg("credentials imported")

	return nil
}

// loadFromDisk loads credentials from persistent storage
func (s *Store) loadFromDisk() error {
	if s.dataDir == "" {
		return nil
	}
	
	credentialsPath := filepath.Join(s.dataDir, "credentials.json")
	
	data, err := os.ReadFile(credentialsPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil // No credentials file yet
		}
		return err
	}
	
	var exported ExportedCredentials
	if err := json.Unmarshal(data, &exported); err != nil {
		return err
	}
	
	return s.Import(&exported)
}

// saveToDisk saves credentials to persistent storage
func (s *Store) saveToDisk() error {
	if s.dataDir == "" {
		return nil
	}
	
	// Ensure directory exists
	if err := os.MkdirAll(s.dataDir, 0755); err != nil {
		return err
	}
	
	credentialsPath := filepath.Join(s.dataDir, "credentials.json")
	
	exported := s.Export()
	data, err := json.MarshalIndent(exported, "", "  ")
	if err != nil {
		return err
	}
	
	return os.WriteFile(credentialsPath, data, 0600) // Secure permissions
}