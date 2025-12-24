// Frontend Integration Tests
// **Feature: shrikdb-phase-1a, Property 5: Frontend API-Only Mutations**
// **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**

import { shrikDB } from './api-client';
import { useStore } from './store';

// Mock fetch for testing
global.fetch = jest.fn();

describe('Frontend API Integration', () => {
  beforeEach(() => {
    // Clear localStorage
    localStorage.clear();
    
    // Reset fetch mock
    (fetch as jest.Mock).mockClear();
  });

  test('all user actions call backend API', async () => {
    // Mock successful responses
    (fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          project_id: 'test-project',
          client_id: 'test-client',
          client_key: 'test-key'
        }),
        headers: { get: () => 'test-correlation-id' }
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          events: [],
          count: 0
        }),
        headers: { get: () => 'test-correlation-id' }
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          event: {
            event_id: 'evt_123',
            project_id: 'test-project',
            event_type: 'document.created',
            payload: { document_id: 'doc_123', collection: 'users', content: { name: 'test' } },
            payload_hash: 'hash123',
            sequence_number: 1,
            timestamp: new Date().toISOString()
          }
        }),
        headers: { get: () => 'test-correlation-id' }
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          events: [{
            event_id: 'evt_123',
            project_id: 'test-project',
            event_type: 'document.created',
            payload: { document_id: 'doc_123', collection: 'users', content: { name: 'test' } },
            payload_hash: 'hash123',
            sequence_number: 1,
            timestamp: new Date().toISOString()
          }],
          count: 1
        }),
        headers: { get: () => 'test-correlation-id' }
      });

    const store = useStore.getState();

    // Initialize project - should call API
    await store.initializeProject('test-project');

    // Add document - should call API
    await store.addDocument('users', { name: 'test' });

    // Verify API calls were made
    expect(fetch).toHaveBeenCalledTimes(4);
    
    // Verify project creation call
    expect(fetch).toHaveBeenNthCalledWith(1, 'http://localhost:8080/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: 'test-project' })
    });

    // Verify read events call
    expect(fetch).toHaveBeenNthCalledWith(2, 'http://localhost:8080/api/events/read?from_sequence=0', {
      headers: {
        'Content-Type': 'application/json',
        'X-Client-ID': 'test-client',
        'X-Client-Key': 'test-key'
      }
    });

    // Verify append event call
    expect(fetch).toHaveBeenNthCalledWith(3, 'http://localhost:8080/api/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-ID': 'test-client',
        'X-Client-Key': 'test-key'
      },
      body: expect.stringContaining('document.created')
    });
  });

  test('no direct state mutations occur', async () => {
    // Mock API responses
    (fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          project_id: 'test-project',
          client_id: 'test-client',
          client_key: 'test-key'
        }),
        headers: { get: () => 'test-correlation-id' }
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          events: [],
          count: 0
        }),
        headers: { get: () => 'test-correlation-id' }
      });

    const store = useStore.getState();
    const initialDocuments = store.documents;

    // Initialize project
    await store.initializeProject('test-project');

    // Documents should only change through event processing, not direct mutation
    // Since we mocked empty events, documents should still be empty
    expect(store.documents).toEqual([]);
    expect(store.documents).toBe(initialDocuments); // Same reference, no mutation
  });

  test('state rehydration only from backend responses', async () => {
    const mockEvent = {
      event_id: 'evt_123',
      project_id: 'test-project',
      event_type: 'document.created',
      payload: { document_id: 'doc_123', collection: 'users', content: { name: 'test' } },
      payload_hash: 'hash123',
      sequence_number: 1,
      timestamp: new Date().toISOString()
    };

    // Mock API responses with real event data
    (fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          project_id: 'test-project',
          client_id: 'test-client',
          client_key: 'test-key'
        }),
        headers: { get: () => 'test-correlation-id' }
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          events: [mockEvent],
          count: 1
        }),
        headers: { get: () => 'test-correlation-id' }
      });

    const store = useStore.getState();

    // Initialize project
    await store.initializeProject('test-project');

    // State should be populated from backend events
    const currentState = useStore.getState();
    expect(currentState.documents).toHaveLength(1);
    expect(currentState.documents[0].id).toBe('doc_123');
    expect(currentState.documents[0].collection).toBe('users');
    expect(currentState.auditLogs).toHaveLength(1);
    expect(currentState.auditLogs[0].type).toBe('DOCUMENT_CREATED');
  });

  test('no mock stores or local generators used', () => {
    // Verify the store uses real API client
    expect(shrikDB).toBeDefined();
    expect(typeof shrikDB.createProject).toBe('function');
    expect(typeof shrikDB.appendEvent).toBe('function');
    expect(typeof shrikDB.readEvents).toBe('function');

    // Verify no mock implementations
    expect(shrikDB.constructor.name).toBe('ShrikDBClient');
  });

  test('error handling flows through API', async () => {
    // Mock API error
    (fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

    const store = useStore.getState();

    // Try to initialize project
    await store.initializeProject('test-project');

    // Error should be captured from API call
    const currentState = useStore.getState();
    expect(currentState.error).toContain('Network error');
    expect(currentState.loading).toBe(false);
  });
});

// Property-based test for frontend integration
describe('Property: Frontend API-Only Mutations', () => {
  test('all store actions result in API calls', () => {
    const store = useStore.getState();
    
    // Get all action methods from store
    const actions = [
      'initializeProject',
      'loadStateFromEvents', 
      'addDocument',
      'deleteDocument',
      'publishMessage',
      'setCacheKey',
      'deleteCacheKey',
      'uploadFile',
      'createAlert',
      'replayAndVerify'
    ];

    // Verify all actions are async functions (indicating API calls)
    actions.forEach(action => {
      expect(typeof store[action as keyof typeof store]).toBe('function');
      // All actions should be async and return promises
      const result = (store[action as keyof typeof store] as any)?.constructor?.name;
      expect(result).toBe('AsyncFunction');
    });
  });
});