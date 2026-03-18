import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { trainJobSchema } from '../schemas/job.schema';
import { trainingQueue } from '../lib/queue';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
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

// ── POST /jobs/train ──────────────────────────────────────────────────────────
router.post('/train', async (req: Request, res: Response): Promise<void> => {
  const parsed = trainJobSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input', code: 'INVALID_INPUT' });
    return;
  }

  const { projectId, datasetId, modelName, method, hyperparams } = parsed.data;
  const userId = req.user!.userId;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { userId: true },
  }).catch((err: unknown) => { logger.error({ err }, 'DB error'); return undefined; });

  if (project === undefined) { res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }); return; }
  if (!project) { res.status(404).json({ error: 'Project not found', code: 'NOT_FOUND' }); return; }
  if (project.userId !== userId) { res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' }); return; }

  const dataset = await prisma.dataset.findUnique({
    where: { id: datasetId },
    select: { projectId: true },
  }).catch((err: unknown) => { logger.error({ err }, 'DB error'); return undefined; });

  if (dataset === undefined) { res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }); return; }
  if (!dataset) { res.status(404).json({ error: 'Dataset not found', code: 'NOT_FOUND' }); return; }
  if (dataset.projectId !== projectId) { res.status(403).json({ error: 'Dataset not in this project', code: 'FORBIDDEN' }); return; }

  const existingJob = await prisma.job.findFirst({
    where: { projectId, datasetId, modelName, status: { in: ['QUEUED', 'RUNNING'] } },
    select: { id: true },
  }).catch((err: unknown) => { logger.error({ err }, 'DB error'); return undefined; });

  if (existingJob === undefined) { res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }); return; }
  if (existingJob) {
    res.status(409).json({ error: 'A training job for this dataset and model is already running', code: 'CONFLICT', jobId: existingJob.id });
    return;
  }

  const epochs = (hyperparams?.epochs as number | undefined) ?? 3;
  const estimatedCost = estimateCost(method, epochs);
  const estimatedDuration = estimateDuration(method, epochs);

  const job = await prisma.job.create({
    data: { projectId, datasetId, modelName, method, hyperparams: hyperparams ?? {}, status: 'QUEUED', estimatedCost },
    select: { id: true },
  }).catch((err: unknown) => { logger.error({ err }, 'DB error creating job'); return null; });

  if (!job) { res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }); return; }

  if (!trainingQueue) {
    await prisma.job.delete({ where: { id: job.id } }).catch(() => null);
    res.status(503).json({ error: 'Job queue unavailable', code: 'QUEUE_ERROR' });
    return;
  }

  try {
    await trainingQueue.add('finetune', { jobId: job.id, projectId, userId, datasetId, modelName, method, hyperparams: hyperparams ?? {} });
  } catch (err: unknown) {
    logger.error({ err, jobId: job.id }, 'BullMQ enqueue failed — rolling back job record');
    await prisma.job.delete({ where: { id: job.id } }).catch(() => null);
    res.status(503).json({ error: 'Job queue unavailable', code: 'QUEUE_ERROR' });
    return;
  }

  logger.info({ userId, jobId: job.id, modelName, method }, 'Training job enqueued');
  res.status(202).json({ jobId: job.id, status: 'queued', estimatedCost, estimatedDuration });
});

// ── GET /jobs/:id/status ──────────────────────────────────────────────────────
router.get('/:id/status', async (req: Request, res: Response): Promise<void> => {
  const jobId = req.params['id'] as string;
  const userId = req.user!.userId;

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: { project: { select: { userId: true } } },
  }).catch((err: unknown) => { logger.error({ err, jobId }, 'DB error'); return undefined; });

  if (job === undefined) { res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }); return; }
  if (!job) { res.status(404).json({ error: 'Job not found', code: 'NOT_FOUND' }); return; }
  if (job.project.userId !== userId) { res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' }); return; }

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
