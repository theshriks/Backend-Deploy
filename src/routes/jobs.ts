import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { trainJobSchema } from '../schemas/job.schema';
import { trainingQueue } from '../lib/queue';
import { stateStore } from '../lib/state-store';
import { logger } from '../lib/logger';
import type { Request, Response } from 'express';

const router = Router();
router.use(authenticate);

function estimateCost(method: string, epochs: number): number {
  const baseRates: Record<string, number> = {
    finetune: 2.4, qlora: 1.2, rlhf: 4.8, rlaif: 3.6,
  };
  return parseFloat(((baseRates[method] ?? 2.4) * (epochs / 3)).toFixed(2));
}

function estimateDuration(method: string, epochs: number): string {
  const baseMins: Record<string, number> = {
    finetune: 45, qlora: 25, rlhf: 90, rlaif: 70,
  };
  const mins = Math.round((baseMins[method] ?? 45) * (epochs / 3));
  return mins >= 60 ? `~${Math.round(mins / 60)}h` : `~${mins}m`;
}

// ── POST /jobs/train ──────────────────────────────────
router.post('/train', async (req: Request, res: Response): Promise<void> => {
  const parsed = trainJobSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input', code: 'INVALID_INPUT' });
    return;
  }

  const { projectId, datasetId, modelName, method, hyperparams } = parsed.data;
  const userId = req.user!.userId;

  // O(1) ownership checks
  const project = stateStore.getProjectById(projectId);
  if (!project) { res.status(404).json({ error: 'Project not found', code: 'NOT_FOUND' }); return; }
  if (project.userId !== userId) { res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' }); return; }

  const dataset = stateStore.getDatasetById(datasetId);
  if (!dataset) { res.status(404).json({ error: 'Dataset not found', code: 'NOT_FOUND' }); return; }
  if (dataset.projectId !== projectId) { res.status(403).json({ error: 'Dataset not in this project', code: 'FORBIDDEN' }); return; }

  const epochs = (hyperparams?.epochs as number | undefined) ?? 3;
  const estimatedCost = estimateCost(method, epochs);
  const estimatedDuration = estimateDuration(method, epochs);

  let job;
  try {
    job = await stateStore.createJob({
      projectId, datasetId, modelName, method,
      hyperparams: hyperparams ?? {},
      estimatedCost,
    });
  } catch (err: unknown) {
    const error = err as { status?: number; code?: string; message?: string; existingJobId?: string };
    if (error.status === 409) {
      res.status(409).json({ error: error.message, code: 'CONFLICT', jobId: error.existingJobId });
      return;
    }
    logger.error({ err }, 'Error creating job');
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    return;
  }

  if (!trainingQueue) {
    // Can't rollback in event sourcing — mark as FAILED instead
    await stateStore.updateJobStatus(job.id, { status: 'FAILED', errorMessage: 'Job queue unavailable' });
    res.status(503).json({ error: 'Job queue unavailable', code: 'QUEUE_ERROR' });
    return;
  }

  try {
    await trainingQueue.add('finetune', {
      jobId: job.id, projectId, userId, datasetId,
      modelName, method, hyperparams: hyperparams ?? {},
    });
  } catch (err: unknown) {
    logger.error({ err, jobId: job.id }, 'BullMQ enqueue failed');
    await stateStore.updateJobStatus(job.id, { status: 'FAILED', errorMessage: 'Queue enqueue failed' });
    res.status(503).json({ error: 'Job queue unavailable', code: 'QUEUE_ERROR' });
    return;
  }

  logger.info({ userId, jobId: job.id, modelName, method }, 'Training job enqueued');
  res.status(202).json({ jobId: job.id, status: 'queued', estimatedCost, estimatedDuration });
});

// ── GET /jobs/:id/status ──────────────────────────────
router.get('/:id/status', (req: Request, res: Response): void => {
  const jobId = req.params['id'] as string;
  const userId = req.user!.userId;

  const job = stateStore.getJobById(jobId);
  if (!job) { res.status(404).json({ error: 'Job not found', code: 'NOT_FOUND' }); return; }

  // Ownership check via project
  const project = stateStore.getProjectById(job.projectId);
  if (!project || project.userId !== userId) {
    res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
    return;
  }

  res.status(200).json({
    status: job.status.toLowerCase(),
    progress: job.progress,
    currentLoss: job.currentLoss,
    step: job.currentStep,
    totalSteps: job.totalSteps,
    eta: job.eta,
    cost: job.actualCost ?? job.estimatedCost,
    ...(job.status === 'FAILED' && { error: job.errorMessage }),
  });
});

export default router;
