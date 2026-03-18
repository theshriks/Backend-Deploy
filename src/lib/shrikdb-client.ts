// ShrikDB Node.js HTTP Client
// Production client — real HTTP calls, zero mocks
// Replaces Prisma as the sole persistence layer

import http from 'http';
import { logger } from './logger';

// ── Response Types ─────────────────────────────────────

export interface ShrikDBEvent {
  event_id: string;
  project_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  payload_hash: string;
  sequence_number: number;
  timestamp: string;
  previous_hash?: string;
  metadata?: Record<string, string>;
}

interface CreateProjectResponse {
  project_id: string;
  client_id: string;
  client_key: string;
  success: boolean;
  error?: string;
}

interface AppendEventResponse {
  event: ShrikDBEvent;
  success: boolean;
  error?: string;
}

interface ReadEventsResponse {
  events: ShrikDBEvent[];
  count: number;
  success: boolean;
  error?: string;
}

interface ReplayResponse {
  progress: {
    ProjectID: string;
    TotalEvents: number;
    ProcessedEvents: number;
    CurrentSequence: number;
    StartTime: string;
    LastEventTime: string;
    Errors: string[] | null;
  };
  success: boolean;
  error?: string;
}

// ── HTTP Helper ────────────────────────────────────────

function httpRequest<T>(
  options: http.RequestOptions,
  body?: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`ShrikDB HTTP ${res.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data) as T);
        } catch {
          reject(new Error(`ShrikDB invalid JSON response: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`ShrikDB connection error: ${err.message}`));
    });

    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('ShrikDB request timeout'));
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

// ── Client Class ───────────────────────────────────────

export class ShrikDBClient {
  private readonly host: string;
  private readonly port: number;
  private clientId: string | null = null;
  private clientKey: string | null = null;
  private projectId: string | null = null;
  private lastSequence = 0;

  constructor(url: string = 'http://localhost:8080') {
    const parsed = new URL(url);
    this.host = parsed.hostname;
    this.port = parseInt(parsed.port, 10) || 8080;
  }

  private getBaseOptions(method: string, path: string): http.RequestOptions {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.clientId && this.clientKey) {
      headers['X-Client-ID'] = this.clientId;
      headers['X-Client-Key'] = this.clientKey;
    }

    return {
      hostname: this.host,
      port: this.port,
      path,
      method,
      headers,
    };
  }

  // ── Project Management ─────────────────────────────

  async createProject(projectId: string): Promise<CreateProjectResponse> {
    const opts = this.getBaseOptions('POST', '/api/projects');
    const body = JSON.stringify({ project_id: projectId });

    const res = await httpRequest<CreateProjectResponse>(opts, body);

    if (res.success) {
      this.clientId = res.client_id;
      this.clientKey = res.client_key;
      this.projectId = projectId;
      logger.info({ projectId }, 'ShrikDB project created');
    }

    return res;
  }

  setCredentials(clientId: string, clientKey: string, projectId: string): void {
    this.clientId = clientId;
    this.clientKey = clientKey;
    this.projectId = projectId;
  }

  isAuthenticated(): boolean {
    return !!(this.clientId && this.clientKey);
  }

  getLastSequence(): number {
    return this.lastSequence;
  }

  // ── Event Operations ───────────────────────────────

  async appendEvent(
    eventType: string,
    payload: Record<string, unknown>,
    metadata?: Record<string, string>
  ): Promise<ShrikDBEvent> {
    if (!this.clientId || !this.clientKey) {
      throw new Error('ShrikDB not authenticated. Create or connect to a project first.');
    }

    const opts = this.getBaseOptions('POST', '/api/events');
    const body = JSON.stringify({
      event_type: eventType,
      payload,
      ...(metadata ? { metadata } : {}),
    });

    const res = await httpRequest<AppendEventResponse>(opts, body);

    if (!res.success) {
      throw new Error(`ShrikDB append failed: ${res.error || 'unknown error'}`);
    }

    this.lastSequence = res.event.sequence_number;
    return res.event;
  }

  async readEvents(fromSequence = 0, limit?: number): Promise<ShrikDBEvent[]> {
    if (!this.clientId || !this.clientKey) {
      throw new Error('ShrikDB not authenticated.');
    }

    let path = `/api/events/read?from_sequence=${fromSequence}`;
    if (limit !== undefined) {
      path += `&limit=${limit}`;
    }

    const opts = this.getBaseOptions('GET', path);
    const res = await httpRequest<ReadEventsResponse>(opts);

    if (!res.success) {
      throw new Error(`ShrikDB read failed: ${res.error || 'unknown error'}`);
    }

    if (res.events.length > 0) {
      this.lastSequence = res.events[res.events.length - 1].sequence_number;
    }

    return res.events;
  }

  async replay(fromSequence = 0, verifyOnly = true): Promise<ReplayResponse> {
    if (!this.clientId || !this.clientKey) {
      throw new Error('ShrikDB not authenticated.');
    }

    const opts = this.getBaseOptions('POST', '/api/replay');
    const body = JSON.stringify({
      from_sequence: fromSequence,
      verify_only: verifyOnly,
    });

    return httpRequest<ReplayResponse>(opts, body);
  }

  // ── Health Check ───────────────────────────────────

  async healthCheck(): Promise<boolean> {
    try {
      const opts: http.RequestOptions = {
        hostname: this.host,
        port: this.port,
        path: '/api/projects',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 3000,
      };

      // Send minimal request to test connectivity
      // Even a 400/500 response means the server is alive
      await new Promise<void>((resolve, reject) => {
        const req = http.request(opts, (res) => {
          res.resume(); // drain response
          resolve();
        });
        req.on('error', (err) => reject(err));
        req.setTimeout(3000, () => {
          req.destroy();
          reject(new Error('healthCheck timeout'));
        });
        req.write(JSON.stringify({ project_id: '__health_check__' }));
        req.end();
      });
      return true;
    } catch {
      return false;
    }
  }
}

// ── Singleton ──────────────────────────────────────────

const shrikdbUrl = process.env['SHRIKDB_URL'] || 'http://localhost:8080';
export const shrikdbClient = new ShrikDBClient(shrikdbUrl);
