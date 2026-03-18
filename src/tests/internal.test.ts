// Internal webhook tests — X-Internal-Secret auth, job-complete, events
// Uses supertest against Express app with mocked ShrikDB (in-memory StateStore)

import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../app';
import { stateStore } from '../lib/state-store';

const INTERNAL_SECRET = 'test-internal-secret';
let jobId: string;
let projectId: string;

beforeAll(async () => {
  await stateStore.initialize('test-project');

  // Create user + project + dataset + job to test against
  const user = await stateStore.createUser({
    name: 'Internal Tester',
    email: `internal-${Date.now()}@modelforge.dev`,
    passwordHash: '$2b$12$fakehashfortestingonly000000000000000000000000',
    role: 'RESEARCHER',
  });

  const project = await stateStore.createProject({
    name: 'Internal Test Project',
    userId: user.id,
  });
  projectId = project.id;

  const dataset = await stateStore.createDataset({
    projectId: project.id,
    fileName: 'train.csv',
    fileType: 'csv',
    minioPath: `datasets/${project.id}/train.csv`,
    sampleCount: 500,
    qualityScore: 0.9,
  });

  const job = await stateStore.createJob({
    projectId: project.id,
    datasetId: dataset.id,
    modelName: 'test-llm',
    method: 'finetune',
  });
  jobId = job.id;

  // Move job to RUNNING so it can be completed
  await stateStore.updateJobStatus(jobId, {
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
  });
});

// ── Auth: X-Internal-Secret ─────────────────────────────

describe('Internal auth middleware', () => {
  it('returns 401 when X-Internal-Secret header missing', async () => {
    const res = await request(app)
      .post('/internal/job-complete')
      .send({ job_id: jobId, status: 'completed' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 when X-Internal-Secret is wrong', async () => {
    const res = await request(app)
      .post('/internal/job-complete')
      .set('X-Internal-Secret', 'wrong-secret')
      .send({ job_id: jobId, status: 'completed' });

    expect(res.status).toBe(401);
  });
});

// ── POST /internal/job-complete ─────────────────────────

describe('POST /internal/job-complete', () => {
  it('returns 404 for non-existent job_id', async () => {
    const res = await request(app)
      .post('/internal/job-complete')
      .set('X-Internal-Secret', INTERNAL_SECRET)
      .send({ job_id: 'nonexistent-id', status: 'completed' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('returns 400 on invalid body', async () => {
    const res = await request(app)
      .post('/internal/job-complete')
      .set('X-Internal-Secret', INTERNAL_SECRET)
      .send({ status: 'completed' }); // missing job_id

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
  });

  it('completes job successfully — 200 with modelId', async () => {
    const res = await request(app)
      .post('/internal/job-complete')
      .set('X-Internal-Secret', INTERNAL_SECRET)
      .send({
        job_id: jobId,
        status: 'completed',
        checkpoint_path: '/checkpoints/test/final',
        final_loss: 0.034,
        duration_min: 45,
        cost_usd: 2.40,
      });

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(res.body.modelId).toBeDefined();

    // Verify job is now COMPLETED in StateStore
    const job = stateStore.getJobById(jobId);
    expect(job?.status).toBe('COMPLETED');
    expect(job?.checkpointPath).toBe('/checkpoints/test/final');
  });

  it('idempotent — second call returns 200 with terminal state note', async () => {
    const res = await request(app)
      .post('/internal/job-complete')
      .set('X-Internal-Secret', INTERNAL_SECRET)
      .send({ job_id: jobId, status: 'completed' });

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(res.body.note).toContain('terminal state');
  });
});

// ── POST /internal/job-complete (failed) ────────────────

describe('POST /internal/job-complete (failed)', () => {
  let failJobId: string;

  beforeAll(async () => {
    const dataset = await stateStore.createDataset({
      projectId,
      fileName: 'fail-test.csv',
      fileType: 'csv',
      minioPath: `datasets/${projectId}/fail-test.csv`,
      sampleCount: 100,
      qualityScore: 0.8,
    });

    const job = await stateStore.createJob({
      projectId,
      datasetId: dataset.id,
      modelName: 'fail-model',
      method: 'finetune',
    });
    failJobId = job.id;

    await stateStore.updateJobStatus(failJobId, {
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });
  });

  it('marks job as FAILED with error message', async () => {
    const res = await request(app)
      .post('/internal/job-complete')
      .set('X-Internal-Secret', INTERNAL_SECRET)
      .send({
        job_id: failJobId,
        status: 'failed',
        error: 'OOM at step 500',
      });

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);

    const job = stateStore.getJobById(failJobId);
    expect(job?.status).toBe('FAILED');
    expect(job?.errorMessage).toBe('OOM at step 500');
  });
});

// ── POST /internal/events ───────────────────────────────

describe('POST /internal/events', () => {
  let eventsJobId: string;

  beforeAll(async () => {
    const dataset = await stateStore.createDataset({
      projectId,
      fileName: 'events-test.csv',
      fileType: 'csv',
      minioPath: `datasets/${projectId}/events-test.csv`,
      sampleCount: 200,
      qualityScore: 0.85,
    });

    const job = await stateStore.createJob({
      projectId,
      datasetId: dataset.id,
      modelName: 'events-model',
      method: 'finetune',
    });
    eventsJobId = job.id;

    await stateStore.updateJobStatus(eventsJobId, {
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });
  });

  it('returns 401 without secret', async () => {
    const res = await request(app)
      .post('/internal/events')
      .send({
        event_type: 'training.step',
        job_id: eventsJobId,
        payload: { step: 10, totalSteps: 100, loss: 0.5 },
      });

    expect(res.status).toBe(401);
  });

  it('broadcasts training.step and updates job progress', async () => {
    const res = await request(app)
      .post('/internal/events')
      .set('X-Internal-Secret', INTERNAL_SECRET)
      .send({
        event_type: 'training.step',
        job_id: eventsJobId,
        payload: { step: 50, totalSteps: 100, loss: 0.125 },
      });

    expect(res.status).toBe(200);
    expect(res.body.broadcast).toBe(true);
    expect(typeof res.body.clients).toBe('number');

    // Verify progress updated in StateStore
    const job = stateStore.getJobById(eventsJobId);
    expect(job?.currentStep).toBe(50);
    expect(job?.progress).toBe(50);
  });

  it('handles non-training events without error', async () => {
    const res = await request(app)
      .post('/internal/events')
      .set('X-Internal-Secret', INTERNAL_SECRET)
      .send({
        event_type: 'custom.event',
        job_id: eventsJobId,
        payload: { custom: 'data' },
      });

    expect(res.status).toBe(200);
    expect(res.body.broadcast).toBe(true);
  });

  it('returns 400 on missing event_type', async () => {
    const res = await request(app)
      .post('/internal/events')
      .set('X-Internal-Secret', INTERNAL_SECRET)
      .send({ job_id: eventsJobId, payload: {} });

    expect(res.status).toBe(400);
  });
});
