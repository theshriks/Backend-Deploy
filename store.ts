import { create } from 'zustand';
import { shrikDB, Event } from './api-client';
import { Document, StreamMessage, CacheItem, StorageFile, AuditLog, AlertRule } from './types';

// PRODUCTION STORE - NO MOCKS, NO FAKE DATA
// All state comes from ShrikDB event log via real API calls

interface AppState {
  // Authentication state
  isAuthenticated: boolean;
  currentProject: string | null;
  clientID: string | null;
  
  // Data state (populated from events)
  documents: Document[];
  streams: string[];
  streamMessages: StreamMessage[];
  cacheItems: CacheItem[];
  files: StorageFile[];
  auditLogs: AuditLog[];
  alertRules: AlertRule[];
  
  // Loading states
  loading: boolean;
  error: string | null;
  
  // Actions - ALL must go through event log
  initializeProject: (projectID: string) => Promise<void>;
  loadStateFromEvents: () => Promise<void>;
  addDocument: (collection: string, content: any) => Promise<void>;
  deleteDocument: (id: string) => Promise<void>;
  publishMessage: (stream: string, payload: any) => Promise<void>;
  setCacheKey: (key: string, value: string, ttl: number) => Promise<void>;
  deleteCacheKey: (key: string) => Promise<void>;
  uploadFile: (name: string, size: number, type: string) => Promise<void>;
  createAlert: (rule: Omit<AlertRule, 'id' | 'active'>) => Promise<void>;
  replayAndVerify: () => Promise<void>;
}

export const useStore = create<AppState>((set, get) => ({
  // Initial state
  isAuthenticated: shrikDB.isAuthenticated(),
  currentProject: shrikDB.getProjectInfo()?.projectID || null,
  clientID: shrikDB.getProjectInfo()?.clientID || null,
  
  documents: [],
  streams: [],
  streamMessages: [],
  cacheItems: [],
  files: [],
  auditLogs: [],
  alertRules: [],
  
  loading: false,
  error: null,

  // Initialize project and create if needed
  initializeProject: async (projectID: string) => {
    set({ loading: true, error: null });
    
    try {
      if (!shrikDB.isAuthenticated()) {
        console.log(`[Store] Creating new project: ${projectID}`);
        const response = await shrikDB.createProject(projectID);
        
        if (!response.success) {
          throw new Error(response.error || 'Failed to create project');
        }
        
        localStorage.setItem('shrikdb_project_id', projectID);
      }
      
      // Load existing state from events
      await get().loadStateFromEvents();
      
      set({ 
        isAuthenticated: true,
        currentProject: projectID,
        clientID: shrikDB.getProjectInfo()?.clientID || null,
        loading: false 
      });
      
    } catch (error) {
      console.error('[Store] Project initialization failed:', error);
      set({ 
        error: error instanceof Error ? error.message : 'Unknown error',
        loading: false 
      });
    }
  },

  // Load current state by replaying all events
  loadStateFromEvents: async () => {
    set({ loading: true, error: null });
    
    try {
      console.log('[Store] Loading state from event log...');
      
      // Read all events from the beginning
      const response = await shrikDB.readEvents(0);
      
      if (!response.success) {
        throw new Error(response.error || 'Failed to read events');
      }
      
      // Rebuild state from events
      const state = rebuildStateFromEvents(response.events);
      
      set({ 
        ...state,
        loading: false,
        error: null 
      });
      
      console.log(`[Store] State loaded from ${response.events.length} events`);
      
    } catch (error) {
      console.error('[Store] Failed to load state from events:', error);
      set({ 
        error: error instanceof Error ? error.message : 'Unknown error',
        loading: false 
      });
    }
  },

  // Add document - MUST create event first
  addDocument: async (collection: string, content: any) => {
    set({ loading: true, error: null });
    
    try {
      // Generate document ID
      const docId = `doc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // Append event to log FIRST
      const response = await shrikDB.appendEvent('document.created', {
        document_id: docId,
        collection,
        content,
        created_at: new Date().toISOString(),
      });
      
      if (!response.success) {
        throw new Error(response.error || 'Failed to append event');
      }
      
      // Reload state from events to get the new document
      await get().loadStateFromEvents();
      
    } catch (error) {
      console.error('[Store] Failed to add document:', error);
      set({ 
        error: error instanceof Error ? error.message : 'Unknown error',
        loading: false 
      });
    }
  },

  // Delete document - MUST create event first
  deleteDocument: async (id: string) => {
    set({ loading: true, error: null });
    
    try {
      // Append event to log FIRST
      const response = await shrikDB.appendEvent('document.deleted', {
        document_id: id,
        deleted_at: new Date().toISOString(),
      });
      
      if (!response.success) {
        throw new Error(response.error || 'Failed to append event');
      }
      
      // Reload state from events
      await get().loadStateFromEvents();
      
    } catch (error) {
      console.error('[Store] Failed to delete document:', error);
      set({ 
        error: error instanceof Error ? error.message : 'Unknown error',
        loading: false 
      });
    }
  },

  // Publish message - MUST create event first
  publishMessage: async (stream: string, payload: any) => {
    set({ loading: true, error: null });
    
    try {
      // Generate message ID
      const msgId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // Append event to log FIRST
      const response = await shrikDB.appendEvent('message.published', {
        message_id: msgId,
        stream,
        payload,
        published_at: new Date().toISOString(),
      });
      
      if (!response.success) {
        throw new Error(response.error || 'Failed to append event');
      }
      
      // Reload state from events
      await get().loadStateFromEvents();
      
    } catch (error) {
      console.error('[Store] Failed to publish message:', error);
      set({ 
        error: error instanceof Error ? error.message : 'Unknown error',
        loading: false 
      });
    }
  },

  // Set cache key - MUST create event first
  setCacheKey: async (key: string, value: string, ttl: number) => {
    set({ loading: true, error: null });
    
    try {
      const response = await shrikDB.appendEvent('cache.set', {
        key,
        value,
        ttl,
        set_at: new Date().toISOString(),
      });
      
      if (!response.success) {
        throw new Error(response.error || 'Failed to append event');
      }
      
      await get().loadStateFromEvents();
      
    } catch (error) {
      console.error('[Store] Failed to set cache key:', error);
      set({ 
        error: error instanceof Error ? error.message : 'Unknown error',
        loading: false 
      });
    }
  },

  // Delete cache key - MUST create event first
  deleteCacheKey: async (key: string) => {
    set({ loading: true, error: null });
    
    try {
      const response = await shrikDB.appendEvent('cache.deleted', {
        key,
        deleted_at: new Date().toISOString(),
      });
      
      if (!response.success) {
        throw new Error(response.error || 'Failed to append event');
      }
      
      await get().loadStateFromEvents();
      
    } catch (error) {
      console.error('[Store] Failed to delete cache key:', error);
      set({ 
        error: error instanceof Error ? error.message : 'Unknown error',
        loading: false 
      });
    }
  },

  // Upload file - MUST create event first
  uploadFile: async (name: string, size: number, type: string) => {
    set({ loading: true, error: null });
    
    try {
      const fileId = `file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      const response = await shrikDB.appendEvent('file.uploaded', {
        file_id: fileId,
        name,
        size,
        type,
        uploaded_at: new Date().toISOString(),
      });
      
      if (!response.success) {
        throw new Error(response.error || 'Failed to append event');
      }
      
      await get().loadStateFromEvents();
      
    } catch (error) {
      console.error('[Store] Failed to upload file:', error);
      set({ 
        error: error instanceof Error ? error.message : 'Unknown error',
        loading: false 
      });
    }
  },

  // Create alert rule - MUST create event first
  createAlert: async (rule: Omit<AlertRule, 'id' | 'active'>) => {
    set({ loading: true, error: null });
    
    try {
      const ruleId = `rule_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      const response = await shrikDB.appendEvent('alert.created', {
        rule_id: ruleId,
        ...rule,
        created_at: new Date().toISOString(),
      });
      
      if (!response.success) {
        throw new Error(response.error || 'Failed to append event');
      }
      
      await get().loadStateFromEvents();
      
    } catch (error) {
      console.error('[Store] Failed to create alert:', error);
      set({ 
        error: error instanceof Error ? error.message : 'Unknown error',
        loading: false 
      });
    }
  },

  // Trigger replay for verification
  replayAndVerify: async () => {
    set({ loading: true, error: null });
    
    try {
      console.log('[Store] Starting replay verification...');
      
      const response = await shrikDB.replay(0, true);
      
      if (!response.success) {
        throw new Error(response.error || 'Replay failed');
      }
      
      console.log(`[Store] Replay verified ${response.progress.processed_events} events`);
      set({ loading: false });
      
    } catch (error) {
      console.error('[Store] Replay verification failed:', error);
      set({ 
        error: error instanceof Error ? error.message : 'Unknown error',
        loading: false 
      });
    }
  },
}));

// Rebuild application state from events (event sourcing projection)
function rebuildStateFromEvents(events: Event[]): Partial<AppState> {
  const documents: Document[] = [];
  const streamMessages: StreamMessage[] = [];
  const cacheItems: CacheItem[] = [];
  const files: StorageFile[] = [];
  const auditLogs: AuditLog[] = [];
  const alertRules: AlertRule[] = [];
  const streams = new Set<string>();
  
  // Process events in order to rebuild state
  for (const event of events) {
    // Add to audit log
    auditLogs.push({
      id: event.event_id,
      type: event.event_type.toUpperCase().replace('.', '_') as any,
      entity: extractEntityId(event),
      timestamp: event.timestamp,
      hash: event.payload_hash,
      details: `Event: ${event.event_type}`,
    });
    
    // Process specific event types
    switch (event.event_type) {
      case 'document.created':
        documents.push({
          id: event.payload.document_id,
          collection: event.payload.collection,
          content: event.payload.content,
          createdAt: event.payload.created_at,
          hash: event.payload_hash,
          historyVersion: 1,
        });
        break;
        
      case 'document.deleted':
        const docIndex = documents.findIndex(d => d.id === event.payload.document_id);
        if (docIndex >= 0) {
          documents.splice(docIndex, 1);
        }
        break;
        
      case 'message.published':
        streams.add(event.payload.stream);
        streamMessages.push({
          id: event.payload.message_id,
          stream: event.payload.stream,
          payload: event.payload.payload,
          timestamp: event.payload.published_at,
          offset: event.sequence_number,
        });
        break;
        
      case 'cache.set':
        // Remove existing key first
        const existingIndex = cacheItems.findIndex(c => c.key === event.payload.key);
        if (existingIndex >= 0) {
          cacheItems.splice(existingIndex, 1);
        }
        
        cacheItems.push({
          key: event.payload.key,
          value: event.payload.value,
          ttl: event.payload.ttl,
          status: 'ACTIVE',
        });
        break;
        
      case 'cache.deleted':
        const cacheIndex = cacheItems.findIndex(c => c.key === event.payload.key);
        if (cacheIndex >= 0) {
          cacheItems.splice(cacheIndex, 1);
        }
        break;
        
      case 'file.uploaded':
        files.push({
          id: event.payload.file_id,
          name: event.payload.name,
          size: event.payload.size,
          type: event.payload.type,
          uploadedAt: event.payload.uploaded_at,
          hash: event.payload_hash,
        });
        break;
        
      case 'alert.created':
        alertRules.push({
          id: event.payload.rule_id,
          source: event.payload.source,
          conditionField: event.payload.conditionField,
          conditionValue: event.payload.conditionValue,
          action: event.payload.action,
          active: true,
        });
        break;
    }
  }
  
  return {
    documents,
    streams: Array.from(streams),
    streamMessages: streamMessages.sort((a, b) => 
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    ),
    cacheItems,
    files,
    auditLogs: auditLogs.reverse(), // Most recent first
    alertRules,
  };
}

// Extract entity ID from event payload
function extractEntityId(event: Event): string {
  const payload = event.payload;
  return payload.document_id || 
         payload.message_id || 
         payload.file_id || 
         payload.rule_id || 
         payload.key || 
         'unknown';
}