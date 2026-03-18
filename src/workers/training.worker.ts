import { Worker, type Job, type ConnectionOptions } from 'bullmq';
import redisConnection from '../lib/redis';
import prisma from '../lib/prisma';
import { broadcastToJob } from '../lib/shrikdb';
import logger from '../lib/logger';

const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL ?? '';
const POLL_INTERVAL_MS = 5_000;
const FINETUNE_TRIGGER_TIMEOUT_MS = 30_000;
const STATUS_POLL_TIMEOUT_MS = 30_000;
const MAX_POLL_ATTEMPTS = 2160; // 5s × 2160 = ~3 hours max training time

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

// ── Typed fetch helpers with timeout ────────────────────────────────────────
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

  if (!res.ok) {
    throw new Error(`Python service returned ${res.status} on ${route}`);
  }
  return res.json() as Promise<NemoStartResponse>;
}

async function pollNemoStatus(nemoJobId: string): Promise<NemoPollResponse> {
  const res = await fetchWithTimeout(
    `${PYTHON_SERVICE_URL}/nemo/job/${nemoJobId}`,
    { method: 'GET' },
    STATUS_POLL_TIMEOUT_MS,
  );

  if (!res.ok) {
    throw new Error(`Python service returned ${res.status} polling job ${nemoJobId}`);
  }
  return res.json() as Promise<NemoPollResponse>;
}

// ── Main worker processor ────────────────────────────────────────────────────
async function processTrainingJob(job: Job<TrainingJobData>): Promise<void> {
  const { jobId, projectId, datasetId, modelName, method, hyperparams } = job.data;
  logger.info({ jobId, modelName, method, attempt: job.attemptsMade + 1 }, 'Training worker picked up job');

  // STEP 1: Mark RUNNING in DB — store startedAt for duration calc
  const jobStartTime = new Date();
  await prisma.job.update({
    where: { id: jobId },
    data: { status: 'RUNNING', startedAt: jobStartTime, errorMessage: null },
  });

  broadcastToJob(jobId, {
    event_type: 'training.step',
    jobId,
    projectId,
    step: 0,
    totalSteps: 0,
    loss: 0,
    lr: 0,
    gpuUtil: 0,
    timestamp: new Date().toISOString(),
  });

  // STEP 2: Validate method before calling Python — unknown/undefined = permanent fail (no retry)
  if (!method) {
    const msg = 'Job missing method field — cannot route to Python';
    logger.error({ jobId }, msg);
    await markJobFailed(jobId, projectId, msg);
    return; // Do NOT throw — returning prevents BullMQ retry
  }

  try {
    getPythonEndpoint(method); // validate method is routable
  } catch (routeErr) {
    const msg = routeErr instanceof Error ? routeErr.message : String(routeErr);
    logger.error({ jobId, method }, msg);
    await markJobFailed(jobId, projectId, msg);
    return; // Do NOT throw — permanent fail, no retry
  }

  // Trigger NeMo training
  let nemoResponse: NemoStartResponse;
  try {
    nemoResponse = await triggerNemoJob(method, {
      jobId,
      datasetId,
      modelName,
      hyperparams,
    });
  } catch (err) {
    logger.error({ err, jobId }, 'Failed to trigger NeMo training');
    // Set back to QUEUED so BullMQ retry finds correct status
    // Only mark permanently FAILED after all retries exhaust (handled by worker.on('failed'))
    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'QUEUED', errorMessage: `Attempt ${job.attemptsMade + 1} failed: ${String(err)}` },
    }).catch((dbErr: unknown) => logger.error({ dbErr, jobId }, 'Failed to reset job to QUEUED'));
    throw err; // BullMQ will retry per queue config
  }

  const nemoJobId = nemoResponse.jobId;
  logger.info({ jobId, nemoJobId }, 'NeMo training triggered');

  await prisma.job.update({
    where: { id: jobId },
    data: { nemoJobId },
  });

  // STEP 3: Poll NeMo status every 5s until done or failed
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
      continue; // network hicup — keep polling
    }

    const now = Date.now();

    // Stale event guard (permanent memory anchor — use timestamp)
    if (now <= lastTimestamp) continue;
    lastTimestamp = now;

    const step = pollData.step;
    const totalSteps = pollData.totalSteps;
    const progress = totalSteps > 0 ? Math.round((step / totalSteps) * 100) : 0;

    // STEP 4: Update DB + broadcast ShrikDB event on every poll
    await prisma.job.update({
      where: { id: jobId },
      data: {
        currentStep: step,
        totalSteps,
        progress,
        currentLoss: pollData.loss,
      },
    });

    broadcastToJob(jobId, {
      event_type: 'training.step',
      jobId,
      projectId,
      step,
      totalSteps,
      loss: pollData.loss,
      lr: pollData.lr,
      gpuUtil: pollData.gpuUtil,
      timestamp: new Date().toISOString(),
    });

    if (pollData.status === 'completed') {
      break;
    }
    if (pollData.status === 'failed') {
      await markJobFailed(jobId, projectId, 'NeMo reported training failure');
      throw new Error('NeMo training failed');
    }
  }

  // If we exit the loop without completion, the job timed out
  if (pollAttempts >= MAX_POLL_ATTEMPTS) {
    await markJobFailed(jobId, projectId, `Training exceeded max duration (~${Math.round(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 60_000)}min)`);
    throw new Error('Training timed out');
  }

  // STEP 5: Mark COMPLETED + store checkpoint path
  const checkpointPath = nemoResponse.checkpointDir ?? `checkpoints/${nemoJobId}`;
  const finalPoll = await pollNemoStatus(nemoJobId).catch(() => null);
  const finalLoss = finalPoll?.loss ?? 0;
  const durationMin = Math.round((Date.now() - jobStartTime.getTime()) / 60_000);
  const gpuHours = parseFloat((durationMin / 60).toFixed(2));

  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: 'COMPLETED',
      progress: 100,
      checkpointPath,
      completedAt: new Date(),
    },
  });

  // Create Model record
  await prisma.model.create({
    data: {
      projectId,
      jobId,
      name: job.data.modelName,
      baseModel: method,
      checkpointPath,
      status: 'TRAINED',
    },
  });

  // Create UsageRecord for billing — uses actual duration, not estimate
  const jobRecord = await prisma.job.findUnique({
    where: { id: jobId },
    select: { estimatedCost: true },
  }).catch(() => null);

  await prisma.usageRecord.create({
    data: {
      userId: job.data.userId,
      jobId,
      gpuHours,
      costUSD: jobRecord?.estimatedCost ?? 0,
    },
  }).catch((err: unknown) => logger.error({ err, jobId }, 'Failed to create UsageRecord'));

  broadcastToJob(jobId, {
    event_type: 'training.completed',
    jobId,
    checkpointPath,
    finalLoss,
    totalSteps: finalPoll?.totalSteps ?? 0,
    durationMin,
    costUSD: jobRecord?.estimatedCost ?? 0,
    timestamp: new Date().toISOString(),
  });

  logger.info({ jobId, checkpointPath, gpuHours }, 'Training job completed');
}

// ── Failure helper ───────────────────────────────────────────────────────────
async function markJobFailed(
  jobId: string,
  projectId: string,
  errorMessage: string,
): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: { status: 'FAILED', errorMessage, completedAt: new Date() },
  }).catch((err: unknown) => logger.error({ err, jobId }, 'Failed to mark job FAILED in DB'));

  broadcastToJob(jobId, {
    event_type: 'training.failed',
    jobId,
    projectId,
    error: errorMessage,
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
