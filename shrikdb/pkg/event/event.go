// Package event defines the canonical event model for ShrikDB.
// Events are immutable, append-only, and form the single source of truth.
package event

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"time"

	"github.com/google/uuid"
)

// Event represents an immutable event in ShrikDB.
// Once created, an event CANNOT be modified or deleted.
// This is the atomic unit of truth in the system.
type Event struct {
	// EventID is globally unique, sortable (UUIDv7-style: timestamp prefix + random)
	EventID string `json:"event_id"`

	// ProjectID isolates events by project/tenant
	ProjectID string `json:"project_id"`

	// EventType is a string identifier for the event kind
	EventType string `json:"event_type"`

	// Payload is the actual event data (JSON)
	Payload json.RawMessage `json:"payload"`

	// PayloadHash is a deterministic SHA-256 hash of the payload
	PayloadHash string `json:"payload_hash"`

	// SequenceNumber is monotonic per project, assigned server-side
	// Guarantees: no gaps, strictly increasing, survives restarts
	SequenceNumber uint64 `json:"sequence_number"`

	// Timestamp is server-generated, monotonic within project
	Timestamp time.Time `json:"timestamp"`

	// PreviousHash chains events for integrity verification (optional but recommended)
	PreviousHash string `json:"previous_hash,omitempty"`

	// Metadata holds optional auxiliary data (tracing, source info, etc.)
	Metadata map[string]string `json:"metadata,omitempty"`
}

// Constants for validation
const (
	MaxPayloadSize = 1024 * 1024 // 1MB max payload size
)

// Regular expressions for validation
var (
	projectIDRegex = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)
	eventTypeRegex = regexp.MustCompile(`^[a-zA-Z0-9_.-]+$`)
)

// Validation errors
var (
	ErrEmptyProjectID    = errors.New("project_id cannot be empty")
	ErrEmptyEventType    = errors.New("event_type cannot be empty")
	ErrEmptyPayload      = errors.New("payload cannot be empty")
	ErrInvalidPayload    = errors.New("payload must be valid JSON")
	ErrHashMismatch      = errors.New("payload hash does not match computed hash")
	ErrInvalidSequence   = errors.New("sequence number must be positive")
	ErrInvalidProjectID  = errors.New("project_id contains invalid characters")
	ErrInvalidEventType  = errors.New("event_type contains invalid characters")
	ErrPayloadTooLarge   = errors.New("payload exceeds maximum size limit")
	ErrInvalidTimestamp  = errors.New("timestamp is invalid or in the future")
	ErrInvalidEventID    = errors.New("event_id format is invalid")
)

// NewEvent creates a new event with server-assigned fields.
// This is the ONLY way to create events - clients cannot set EventID, SequenceNumber, or Timestamp.
func NewEvent(projectID, eventType string, payload json.RawMessage, sequenceNum uint64, previousHash string, metadata map[string]string) (*Event, error) {
	if projectID == "" {
		return nil, ErrEmptyProjectID
	}
	if eventType == "" {
		return nil, ErrEmptyEventType
	}
	if len(payload) == 0 {
		return nil, ErrEmptyPayload
	}

	// Validate project ID format
	if !projectIDRegex.MatchString(projectID) {
		return nil, ErrInvalidProjectID
	}

	// Validate event type format
	if !eventTypeRegex.MatchString(eventType) {
		return nil, ErrInvalidEventType
	}

	// Validate payload size
	if len(payload) > MaxPayloadSize {
		return nil, ErrPayloadTooLarge
	}

	// Validate sequence number
	if sequenceNum == 0 {
		return nil, ErrInvalidSequence
	}

	// Validate payload is valid JSON
	if !json.Valid(payload) {
		return nil, ErrInvalidPayload
	}

	// Canonicalize payload for deterministic hashing
	canonicalPayload, err := canonicalizeJSON(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to canonicalize payload: %w", err)
	}

	// Generate deterministic hash
	payloadHash := computeHash(canonicalPayload)

	// Generate sortable event ID (timestamp-prefixed UUID)
	eventID := generateSortableID()

	// Create timestamp
	timestamp := time.Now().UTC()

	return &Event{
		EventID:        eventID,
		ProjectID:      projectID,
		EventType:      eventType,
		Payload:        canonicalPayload,
		PayloadHash:    payloadHash,
		SequenceNumber: sequenceNum,
		Timestamp:      timestamp,
		PreviousHash:   previousHash,
		Metadata:       metadata,
	}, nil
}


// VerifyIntegrity checks that the event's payload hash matches the actual payload.
// Returns nil if valid, error otherwise.
func (e *Event) VerifyIntegrity() error {
	canonicalPayload, err := canonicalizeJSON(e.Payload)
	if err != nil {
		return fmt.Errorf("failed to canonicalize payload: %w", err)
	}

	computedHash := computeHash(canonicalPayload)
	if computedHash != e.PayloadHash {
		return ErrHashMismatch
	}
	return nil
}

// VerifyChain checks that this event's PreviousHash matches the given hash.
// Used for chain integrity verification during replay.
func (e *Event) VerifyChain(expectedPreviousHash string) bool {
	return e.PreviousHash == expectedPreviousHash
}

// ComputeEventHash returns a hash of the entire event (for chaining).
// This is used as the PreviousHash for the next event.
func (e *Event) ComputeEventHash() string {
	// Hash: event_id + payload_hash + sequence_number
	data := fmt.Sprintf("%s:%s:%d", e.EventID, e.PayloadHash, e.SequenceNumber)
	return computeHash([]byte(data))
}

// Serialize converts the event to bytes for storage.
// Uses JSON for human-readability and debuggability.
func (e *Event) Serialize() ([]byte, error) {
	return json.Marshal(e)
}

// Deserialize reconstructs an event from bytes.
func Deserialize(data []byte) (*Event, error) {
	var e Event
	if err := json.Unmarshal(data, &e); err != nil {
		return nil, fmt.Errorf("failed to deserialize event: %w", err)
	}
	
	// Validate the deserialized event
	if err := e.Validate(); err != nil {
		return nil, fmt.Errorf("invalid event after deserialization: %w", err)
	}
	
	return &e, nil
}

// Validate performs comprehensive validation on an event.
func (e *Event) Validate() error {
	if e.EventID == "" {
		return ErrInvalidEventID
	}
	if e.ProjectID == "" {
		return ErrEmptyProjectID
	}
	if e.EventType == "" {
		return ErrEmptyEventType
	}
	if len(e.Payload) == 0 {
		return ErrEmptyPayload
	}
	if e.SequenceNumber == 0 {
		return ErrInvalidSequence
	}
	if e.Timestamp.IsZero() {
		return ErrInvalidTimestamp
	}
	
	// Validate project ID format
	if !projectIDRegex.MatchString(e.ProjectID) {
		return ErrInvalidProjectID
	}
	
	// Validate event type format
	if !eventTypeRegex.MatchString(e.EventType) {
		return ErrInvalidEventType
	}
	
	// Validate payload size
	if len(e.Payload) > MaxPayloadSize {
		return ErrPayloadTooLarge
	}
	
	// Validate payload is valid JSON
	if !json.Valid(e.Payload) {
		return ErrInvalidPayload
	}
	
	// Verify integrity
	return e.VerifyIntegrity()
}

// computeHash returns a deterministic SHA-256 hash as hex string.
func computeHash(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

// generateSortableID creates a time-sortable unique ID.
// Format: timestamp_hex (16 chars) + uuid (8 chars) = 24 chars
// This ensures events are naturally sortable by creation time.
func generateSortableID() string {
	now := time.Now().UnixNano()
	uid := uuid.New()
	return fmt.Sprintf("%016x%s", now, uid.String()[:8])
}

// canonicalizeJSON ensures deterministic JSON representation.
// Keys are sorted alphabetically, no extra whitespace.
func canonicalizeJSON(data json.RawMessage) ([]byte, error) {
	var obj interface{}
	if err := json.Unmarshal(data, &obj); err != nil {
		return nil, err
	}
	return canonicalMarshal(obj)
}

// canonicalMarshal recursively marshals with sorted keys.
func canonicalMarshal(v interface{}) ([]byte, error) {
	switch val := v.(type) {
	case map[string]interface{}:
		// Sort keys for deterministic output
		keys := make([]string, 0, len(val))
		for k := range val {
			keys = append(keys, k)
		}
		sort.Strings(keys)

		result := []byte("{")
		for i, k := range keys {
			if i > 0 {
				result = append(result, ',')
			}
			keyBytes, _ := json.Marshal(k)
			result = append(result, keyBytes...)
			result = append(result, ':')
			valBytes, err := canonicalMarshal(val[k])
			if err != nil {
				return nil, err
			}
			result = append(result, valBytes...)
		}
		result = append(result, '}')
		return result, nil

	case []interface{}:
		result := []byte("[")
		for i, item := range val {
			if i > 0 {
				result = append(result, ',')
			}
			itemBytes, err := canonicalMarshal(item)
			if err != nil {
				return nil, err
			}
			result = append(result, itemBytes...)
		}
		result = append(result, ']')
		return result, nil

	default:
		return json.Marshal(val)
	}
}
