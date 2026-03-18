// Jobs integration tests — training job creation and validation
// Uses supertest against Express app with mocked ShrikDB (in-memory StateStore)

import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../app';
import { stateStore } from '../lib/state-store';

let accessToken: string;
let projectId: string;
let datasetId: string;

beforeAll(async () => {
  await stateStore.initialize('test-project');

  // Create a test user
  const signupRes = await request(app).post('/auth/signup').send({
    email: `jobs-test-${Date.now()}@modelforge.dev`,
    name: 'Jobs Tester',
    password: 'testpass123',
  });
  accessToken = signupRes.body.accessToken;

  // Create a test project
  const projectRes = await request(app)
    .post('/projects')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ name: 'Test Training Project' });
  projectId = projectRes.body.id;

  // Create a test dataset (in StateStore only — MinIO is mocked)
  const dataset = await stateStore.createDataset({
    projectId,
    fileName: 'train.csv',
    fileType: 'csv',
    minioPath: `datasets/${projectId}/train.csv`,
    sampleCount: 1000,
    qualityScore: 0.95,
  });
  datasetId = dataset.id;
});

// ── Create Training Job ─────────────────────────────────

describe('POST /jobs/train', () => {
  it('returns 400 on missing required fields', async () => {
    const res = await request(app)
      .post('/jobs/train')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ projectId });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
  });

  it('returns 404 on non-existent project', async () => {
    const res = await request(app)
      .post('/jobs/train')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        projectId: '00000000-0000-0000-0000-000000000000',
        datasetId: '00000000-0000-0000-0000-000000000000',
        modelName: 'test-model',
        method: 'finetune',
      });

    expect(res.status).toBe(404);
  });

  it('returns 401 without auth token', async () => {
    const res = await request(app)
      .post('/jobs/train')
      .send({
        projectId,
        datasetId,
        modelName: 'test-model',
        method: 'finetune',
      });

    expect(res.status).toBe(401);
  });
});

// ── Job Status ──────────────────────────────────────────

describe('GET /jobs/:id/status', () => {
  it('returns 404 for non-existent job', async () => {
    const res = await request(app)
      .get('/jobs/nonexistent-job-id/status')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(404);
  });

  it('returns 401 without auth token', async () => {
    const res = await request(app).get('/jobs/any-id/status');
    expect(res.status).toBe(401);
  });
});

// ── Projects CRUD ───────────────────────────────────────

describe('Projects', () => {
  it('GET /projects returns array of user projects', async () => {
    const res = await request(app)
      .get('/projects')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0].name).toBe('Test Training Project');
  });

  it('POST /projects returns 400 on empty name', async () => {
    const res = await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: '' });

    expect(res.status).toBe(400);
  });

  it('POST /projects creates project with valid name', async () => {
    const res = await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Second Project' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe('Second Project');
  });
});
