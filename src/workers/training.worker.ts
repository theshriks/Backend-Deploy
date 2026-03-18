import { Worker, type Job, type ConnectionOptions } from 'bullmq';
import redisConnection from '../lib/redis';
import { stateStore } from '../lib/state-store';
import { broadcastToJob } from '../lib/shrikdb';
import { logger } from '../lib/logger';

const PYTHON_SERVICE_URL = process.env['PYTHON_SERVICE_URL'] ?? '';
const POLL_INTERVAL_MS = 5_000;
const FINETUNE_TRIGGER_TIMEOUT_MS = 30_000;
const STATUS_POLL_TIMEOUT_MS = 30_000;
const MAX_POLL_ATTEMPTS = 2160; // 5s × 2160 = ~3 hours max

interface TrainingJobData {
  jobId: string;
  projectId: string;
  userId: string;
  datasetId: string;
  modelName: string;
  method: string;
  hyperparams: Record<string, unknown>;
}

interface NemoStartResponse {
  jobId: string;
  status: string;
  checkpointDir?: string;
}

interface NemoPollResponse {
  status: string;
  step: number;
  totalSteps: number;
  loss: number;
  lr: number;
  gpuUtil: number;
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function getPythonEndpoint(method: string): string {
  switch (method) {
    case 'SFT':
    case 'LoRA':
    case 'QLoRA':
      return '/nemo/finetune';
    case 'RLHF':
      return '/nemo/rlhf';
    case 'RLAIF':
      return '/nemo/rlaif';
    default:
      throw new Error(`Unknown training method: ${method}. Valid: SFT, LoRA, QLoRA, RLHF, RLAIF`);
  }
}

async function triggerNemoJob(
  method: string,
  payload: Record<string, unknown>,
): Promise<NemoStartResponse> {
  const route = getPythonEndpoint(method);
  const res = await fetchWithTimeout(
    `${PYTHON_SERVICE_URL}${route}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    FINETUNE_TRIGGER_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`Python service returned ${res.status} on ${route}`);
  return res.json() as Promise<NemoStartResponse>;
}

async function pollNemoStatus(nemoJobId: string): Promise<NemoPollResponse> {
  const res = await fetchWithTimeout(
    `${PYTHON_SERVICE_URL}/nemo/job/${nemoJobId}`,
    { method: 'GET' },
    STATUS_POLL_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`Python service returned ${res.status} polling job ${nemoJobId}`);
  return res.json() as Promise<NemoPollResponse>;
}

// ── Main worker processor ────────────────────────────────────────────────────
async function processTrainingJob(job: Job<TrainingJobData>): Promise<void> {
  const { jobId, projectId, datasetId, modelName, method, hyperparams } = job.data;
  logger.info({ jobId, modelName, method, attempt: job.attemptsMade + 1 }, 'Training worker picked up job');

  // STEP 1: Mark RUNNING
  const jobStartTime = new Date();
  await stateStore.updateJobStatus(jobId, {
    status: 'RUNNING',
    startedAt: jobStartTime.toISOString(),
    errorMessage: undefined,
  });

  broadcastToJob(jobId, {
    event_type: 'training.step',
    jobId, projectId,
    step: 0, totalSteps: 0, loss: 0, lr: 0, gpuUtil: 0,
    timestamp: new Date().toISOString(),
  });

  // STEP 2: Validate method
  if (!method) {
    const msg = 'Job missing method field — cannot route to Python';
    logger.error({ jobId }, msg);
    await markJobFailed(jobId, projectId, msg);
    return;
  }

  try {
    getPythonEndpoint(method);
  } catch (routeErr) {
    const msg = routeErr instanceof Error ? routeErr.message : String(routeErr);
    logger.error({ jobId, method }, msg);
    await markJobFailed(jobId, projectId, msg);
    return;
  }

  // Trigger NeMo training
  let nemoResponse: NemoStartResponse;
  try {
    nemoResponse = await triggerNemoJob(method, { jobId, datasetId, modelName, hyperparams });
  } catch (err) {
    logger.error({ err, jobId }, 'Failed to trigger NeMo training');
    await stateStore.updateJobStatus(jobId, {
      status: 'QUEUED',
      errorMessage: `Attempt ${job.attemptsMade + 1} failed: ${String(err)}`,
    });
    throw err; // BullMQ will retry
  }

  const nemoJobId = nemoResponse.jobId;
  logger.info({ jobId, nemoJobId }, 'NeMo training triggered');

  await stateStore.updateJobStatus(jobId, { status: 'RUNNING', nemoJobId });

  // STEP 3: Poll NeMo status
  let lastTimestamp = 0;
  let pollAttempts = 0;

  while (pollAttempts < MAX_POLL_ATTEMPTS) {
    await sleep(POLL_INTERVAL_MS);
    pollAttempts++;

    let pollData: NemoPollResponse;
    try {
      pollData = await pollNemoStatus(nemoJobId);
    } catch (err) {
      logger.warn({ err, jobId, nemoJobId }, 'Poll failed — will retry next interval');
      continue;
    }

    const now = Date.now();
    if (now <= lastTimestamp) continue;
    lastTimestamp = now;

    const step = pollData.step;
    const totalSteps = pollData.totalSteps;
    const progress = totalSteps > 0 ? Math.round((step / totalSteps) * 100) : 0;

    await stateStore.updateJobProgress(jobId, {
      progress,
      currentStep: step,
      totalSteps,
      currentLoss: pollData.loss,
    });

    broadcastToJob(jobId, {
      event_type: 'training.step',
      jobId, projectId, step, totalSteps,
      loss: pollData.loss, lr: pollData.lr, gpuUtil: pollData.gpuUtil,
      timestamp: new Date().toISOString(),
    });

    if (pollData.status === 'completed') break;
    if (pollData.status === 'failed') {
      await markJobFailed(jobId, projectId, 'NeMo reported training failure');
      throw new Error('NeMo training failed');
    }
  }

  if (pollAttempts >= MAX_POLL_ATTEMPTS) {
    await markJobFailed(jobId, projectId, `Training exceeded max duration (~${Math.round(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 60_000)}min)`);
    throw new Error('Training timed out');
  }

  // STEP 5: Mark COMPLETED
  const checkpointPath = nemoResponse.checkpointDir ?? `checkpoints/${nemoJobId}`;
  const finalPoll = await pollNemoStatus(nemoJobId).catch(() => null);
  const finalLoss = finalPoll?.loss ?? 0;
  const durationMin = Math.round((Date.now() - jobStartTime.getTime()) / 60_000);
  const gpuHours = parseFloat((durationMin / 60).toFixed(2));

  await stateStore.updateJobStatus(jobId, {
    status: 'COMPLETED',
    checkpointPath,
    completedAt: new Date().toISOString(),
  });
  await stateStore.updateJobProgress(jobId, { progress: 100 });

  // Create Model record
  await stateStore.createModel({
    projectId,
    jobId,
    name: job.data.modelName,
    baseModel: method,
    checkpointPath,
  });

  // Create UsageRecord
  const jobRecord = stateStore.getJobById(jobId);
  await stateStore.recordUsage({
    userId: job.data.userId,
    jobId,
    gpuHours,
    costUSD: jobRecord?.estimatedCost ?? 0,
  });

  broadcastToJob(jobId, {
    event_type: 'training.completed',
    jobId, checkpointPath, finalLoss,
    totalSteps: finalPoll?.totalSteps ?? 0,
    durationMin,
    costUSD: jobRecord?.estimatedCost ?? 0,
    timestamp: new Date().toISOString(),
  });

  logger.info({ jobId, checkpointPath, gpuHours }, 'Training job completed');
}

async function markJobFailed(jobId: string, projectId: string, errorMessage: string): Promise<void> {
  await stateStore.updateJobStatus(jobId, {
    status: 'FAILED',
    errorMessage,
    completedAt: new Date().toISOString(),
  });

  broadcastToJob(jobId, {
    event_type: 'training.failed',
    jobId, projectId, error: errorMessage,
    timestamp: new Date().toISOString(),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Worker bootstrap ─────────────────────────────────────────────────────────
export function startTrainingWorker(): Worker<TrainingJobData> | null {
  if (!redisConnection) {
    logger.warn('Redis not available — training worker will not start');
    return null;
  }

  if (!PYTHON_SERVICE_URL) {
    logger.warn('PYTHON_SERVICE_URL not set — training worker will start but NeMo calls will fail');
  }

  const worker = new Worker<TrainingJobData>('training', processTrainingJob, {
    connection: redisConnection as unknown as ConnectionOptions,
    concurrency: 3,
  });

  worker.on('completed', (job) => {
    logger.info({ jobId: job.data.jobId }, 'Training job completed successfully');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.data.jobId, err }, 'Training job permanently failed');
    if (job?.data.jobId) {
      void markJobFailed(job.data.jobId, job.data.projectId, err.message);
    }
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'Training worker error');
  });

  logger.info('Training worker started (concurrency: 3)');
  return worker;
}
