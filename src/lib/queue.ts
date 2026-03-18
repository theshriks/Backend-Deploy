import { Queue, type ConnectionOptions } from 'bullmq';
import redisConnection from './redis';
import logger from './logger';

// ── Typed job data (no `any`) ─────────────────────────────────────
export interface TrainingJobData {
  jobId: string;
  projectId: string;
  userId: string;
  datasetId: string;
  modelName: string;
  method: string;
  hyperparams: Record<string, unknown>;
}

// ── Queue initialization ──────────────────────────────────────────
let trainingQueue: Queue<TrainingJobData> | null = null;

if (redisConnection) {
  trainingQueue = new Queue<TrainingJobData>('training', {
    connection: redisConnection as unknown as ConnectionOptions,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    },
  });
  logger.info('BullMQ training queue initialized');
} else {
  logger.warn('Training queue unavailable — Redis not connected');
}

// ── Typed helper to enqueue a training job ────────────────────────
export async function addTrainingJob(data: TrainingJobData): Promise<string | null> {
  if (!trainingQueue) {
    logger.error('Cannot add training job — queue unavailable');
    return null;
  }

  const job = await trainingQueue.add('finetune', data, {
    jobId: data.jobId, // Deduplication — BullMQ won't enqueue duplicate jobIds
  });

  logger.info({ jobId: data.jobId, bullmqId: job.id }, 'Training job enqueued');
  return job.id ?? null;
}

export { trainingQueue };
export default trainingQueue;
