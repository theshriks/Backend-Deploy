// Production API client for ShrikDB Phase 1A
// NO MOCKS - Real HTTP calls to backend event log

export interface Event {
  event_id: string;
  project_id: string;
  event_type: string;
  payload: any;
  payload_hash: string;
  sequence_number: number;
  timestamp: string;
  previous_hash?: string;
  metadata?: Record<string, string>;
}

export interface AppendEventResponse {
  event: Event;
  success: boolean;
  error?: string;
}

export interface ReadEventsResponse {
  events: Event[];
  count: number;
  success: boolean;
  error?: string;
}

export interface ReplayResponse {
  progress: {
    project_id: string;
    total_events: number;
    processed_events: number;
    current_sequence: number;
    start_time: string;
    last_event_time: string;
    errors: string[];
  };
  success: boolean;
  error?: string;
}

export interface CreateProjectResponse {
  project_id: string;
  client_id: string;
  client_key: string;
  success: boolean;
  error?: string;
}

class ShrikDBClient {
  private baseURL: string;
  private clientID: string | null = null;
  private clientKey: string | null = null;

  constructor(baseURL: string = 'http://localhost:8081') {
    this.baseURL = baseURL;
    
    // Load credentials from localStorage if available
    this.clientID = localStorage.getItem('shrikdb_client_id');
    this.clientKey = localStorage.getItem('shrikdb_client_key');
  }

  private async request<T>(
    endpoint: string, 
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseURL}${endpoint}`;
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options.headers as Record<string, string>,
    };

    // Add authentication headers if available
    if (this.clientID && this.clientKey) {
      headers['X-Client-ID'] = this.clientID;
      headers['X-Client-Key'] = this.clientKey;
    }

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const correlationID = response.headers.get('X-Correlation-ID');
    console.log(`[ShrikDB] Request ${correlationID}: ${options.method || 'GET'} ${endpoint}`);

    return response.json();
  }

  // Create a new project and store credentials
  async createProject(projectID: string): Promise<CreateProjectResponse> {
    const response = await this.request<CreateProjectResponse>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ project_id: projectID }),
    });

    if (response.success) {
      // Store credentials securely
      this.clientID = response.client_id;
      this.clientKey = response.client_key;
      localStorage.setItem('shrikdb_client_id', response.client_id);
      localStorage.setItem('shrikdb_client_key', response.client_key);
      
      console.log(`[ShrikDB] Project created: ${projectID}`);
    }

    return response;
  }

  // Append an event to the log (CRITICAL: This is the ONLY way to create data)
  async appendEvent(
    eventType: string, 
    payload: any, 
    metadata?: Record<string, string>
  ): Promise<AppendEventResponse> {
    if (!this.clientID || !this.clientKey) {
      throw new Error('Not authenticated. Create a project first.');
    }

    const response = await this.request<AppendEventResponse>('/api/events', {
      method: 'POST',
      body: JSON.stringify({
        event_type: eventType,
        payload,
        metadata,
      }),
    });

    if (response.success) {
      console.log(`[ShrikDB] Event appended: ${response.event.event_id} (seq: ${response.event.sequence_number})`);
    }

    return response;
  }

  // Read events from the log
  async readEvents(
    fromSequence: number = 0, 
    limit?: number
  ): Promise<ReadEventsResponse> {
    if (!this.clientID || !this.clientKey) {
      throw new Error('Not authenticated. Create a project first.');
    }

    const params = new URLSearchParams({
      from_sequence: fromSequence.toString(),
    });
    
    if (limit) {
      params.set('limit', limit.toString());
    }

    const response = await this.request<ReadEventsResponse>(
      `/api/events/read?${params.toString()}`
    );

    if (response.success) {
      console.log(`[ShrikDB] Read ${response.count} events from sequence ${fromSequence}`);
    }

    return response;
  }

  // Trigger replay for integrity verification
  async replay(fromSequence: number = 0, verifyOnly: boolean = true): Promise<ReplayResponse> {
    if (!this.clientID || !this.clientKey) {
      throw new Error('Not authenticated. Create a project first.');
    }

    const response = await this.request<ReplayResponse>('/api/replay', {
      method: 'POST',
      body: JSON.stringify({
        from_sequence: fromSequence,
        verify_only: verifyOnly,
      }),
    });

    if (response.success) {
      console.log(`[ShrikDB] Replay completed: ${response.progress.processed_events} events processed`);
    }

    return response;
  }

  // Check if client is authenticated
  isAuthenticated(): boolean {
    return !!(this.clientID && this.clientKey);
  }

  // Get current project info
  getProjectInfo(): { clientID: string; projectID: string } | null {
    if (!this.clientID) return null;
    
    // Extract project ID from stored data or use default
    const projectID = localStorage.getItem('shrikdb_project_id') || 'default-project';
    
    return {
      clientID: this.clientID,
      projectID,
    };
  }

  // Clear authentication (logout)
  clearAuth(): void {
    this.clientID = null;
    this.clientKey = null;
    localStorage.removeItem('shrikdb_client_id');
    localStorage.removeItem('shrikdb_client_key');
    localStorage.removeItem('shrikdb_project_id');
  }
}

// Export singleton instance
export const shrikDB = new ShrikDBClient();

// Export types for use in components
export type { Event, AppendEventResponse, ReadEventsResponse, ReplayResponse, CreateProjectResponse };