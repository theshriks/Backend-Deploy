// Test setup — runs before all test files
// Mocks ShrikDB client so StateStore works purely in-memory (no live ShrikDB needed)

import { vi } from 'vitest';

// ── Mock ShrikDB client BEFORE any imports that use it ──────────────────────
vi.mock('../lib/shrikdb-client', () => ({
  shrikdbClient: {
    createProject: vi.fn().mockResolvedValue({
      success: true,
      project_id: 'test-project',
      client_id: 'test-client-id',
      client_key: 'test-client-key',
    }),
    setCredentials: vi.fn(),
    isAuthenticated: vi.fn().mockReturnValue(true),
    appendEvent: vi.fn().mockResolvedValue({
      event_id: 'mock-event-id',
      sequence_number: 1,
    }),
    readEvents: vi.fn().mockResolvedValue([]),
    healthCheck: vi.fn().mockResolvedValue(true),
  },
  ShrikDBEvent: {},
}));

// ── Mock MinIO so ensureBuckets/putObjectStream don't need a live server ─────
vi.mock('../lib/minio', () => ({
  BUCKETS: {
    DATASETS: 'datasets',
    CHECKPOINTS: 'checkpoints',
    MODELS: 'models',
    COMPLIANCE: 'compliance-docs',
  },
  ensureBuckets: vi.fn().mockResolvedValue(undefined),
  putObjectStream: vi.fn().mockResolvedValue(undefined),
  getObject: vi.fn().mockResolvedValue(Buffer.from('mock')),
  listObjects: vi.fn().mockResolvedValue([]),
}));

// ── Mock Redis so BullMQ doesn't need a live connection ─────────────────────
vi.mock('../lib/redis', () => ({
  default: null,
  __esModule: true,
}));

// ── Mock queue so training jobs don't need Redis ────────────────────────────
vi.mock('../lib/queue', () => ({
  trainingQueue: null,
  addTrainingJob: vi.fn().mockResolvedValue('mock-bullmq-id'),
  default: null,
}));

// ── Mock training worker ────────────────────────────────────────────────────
vi.mock('../workers/training.worker', () => ({
  startTrainingWorker: vi.fn().mockReturnValue(null),
}));

// ── Mock shrikdb WebSocket broadcaster ──────────────────────────────────────
vi.mock('../lib/shrikdb', () => ({
  initShrikDBWebSocket: vi.fn(),
  broadcastToJob: vi.fn(),
  getConnectedClientCount: vi.fn().mockReturnValue(0),
  emitEvent: vi.fn().mockResolvedValue(undefined),
  testEventEmit: vi.fn().mockResolvedValue(undefined),
}));

// ── Set test environment variables ──────────────────────────────────────────
process.env['JWT_SECRET'] = 'test-jwt-secret-minimum-32-chars-long-for-testing';
process.env['JWT_REFRESH_SECRET'] = 'test-refresh-secret-different-value-for-testing';
process.env['SHRIKDB_URL'] = 'http://localhost:8080';
process.env['SHRIKDB_PROJECT_ID'] = 'test-project';
process.env['SHRIKDB_CLIENT_ID'] = 'test-client-id';
process.env['SHRIKDB_CLIENT_KEY'] = 'test-client-key';
process.env['INTERNAL_SECRET'] = 'test-internal-secret';
process.env['NODE_ENV'] = 'test';
process.env['PORT'] = '3001';
