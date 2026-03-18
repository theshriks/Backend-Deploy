// ── Internal Webhook Routes ──────────────────────────────────────────────────
// Called by Laukik's Python NeMo service to push training results into Node.js.
// Auth: shared secret header (X-Internal-Secret), NOT JWT.
//
// POST /internal/job-complete  → training finished (success or failure)
// POST /internal/events        → streaming training step events (live dashboard)

import { Router } from 'express';
import { z } from 'zod';
import { stateStore } from '../lib/state-store';
import { broadcastToJob, getConnectedClientCount } from '../lib/shrikdb';
import { logger } from '../lib/logger';
import type { Request, Response, NextFunction } from 'express';

const router = Router();

// ── Shared Secret Middleware (internal to this file) ─────────────────────────

function verifyInternalSecret(req: Request, res: Response, next: NextFunction): void {
  const secret = req.headers['x-internal-secret'];
  const expected = process.env['INTERNAL_SECRET'];

  if (!expected) {
    logger.error('[internal] INTERNAL_SECRET env var not set');
    res.status(500).json({ error: 'Server misconfigured', code: 'INTERNAL_ERROR' });
    return;
  }

  if (!secret || secret !== expected) {
    logger.warn('[internal] Invalid internal secret attempt');
    res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    return;
  }
  next();
}

router.use(verifyInternalSecret);

// ── Schemas ─────────────────────────────────────────────────────────────────

const jobCompleteSchema = z.object({
  job_id: z.string().min(1),
  status: z.enum(['completed', 'failed']),
  checkpoint_path: z.string().optional(),
  final_loss: z.number().optional(),
  duration_min: z.number().optional(),
  cost_usd: z.number().optional(),
  error: z.string().optional(),
});

const eventsSchema = z.object({
  event_type: z.string().min(1),
  job_id: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  timestamp: z.string().optional(),
});

// ── POST /internal/job-complete ─────────────────────────────────────────────

router.post('/job-complete', async (req: Request, res: Response): Promise<void> => {
  const parsed = jobCompleteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input', code: 'INVALID_INPUT' });
    return;
  }

  const body = parsed.data;

  // 1. Find job → 404 if not found
  const job = stateStore.getJobById(body.job_id);
  if (!job) {
    res.status(404).json({ error: 'Job not found', code: 'NOT_FOUND' });
    return;
  }

  // 2. Idempotency: if already in terminal state, acknowledge and skip
  if (job.status === 'COMPLETED' || job.status === 'FAILED') {
    res.status(200).json({ received: true, note: 'Job already in terminal state — ignored' });
    return;
  }

  if (body.status === 'completed') {
    // ── COMPLETED flow ────────────────────────────────

    if (!body.checkpoint_path) {
      logger.warn({ jobId: body.job_id }, '[internal] job-complete received without checkpoint_path');
    }

    // 3. Update job status
    try {
      await stateStore.updateJobStatus(body.job_id, {
        status: 'COMPLETED',
        checkpointPath: body.checkpoint_path,
        completedAt: new Date().toISOString(),
        actualCost: body.cost_usd,
      });
    } catch (err) {
      logger.error({ err, jobId: body.job_id }, '[internal] Failed to update job status');
      res.status(500).json({ error: 'Failed to update job', code: 'INTERNAL_ERROR' });
      return;
    }

    // 4. Create Model record (catch duplicate — unique jobId constraint)
    let modelId: string | null = null;
    try {
      const model = await stateStore.createModel({
        projectId: job.projectId,
        jobId: job.id,
        name: `${job.modelName}-v1`,
        version: '1.0.0',
        baseModel: job.modelName,
        checkpointPath: body.checkpoint_path ?? '',
      });
      modelId = model.id;
    } catch (err: unknown) {
      const error = err as { status?: number };
      if (error.status === 409) {
        // Model already exists for this job — expected on duplicate calls
        logger.warn({ jobId: job.id }, '[internal] Model already exists for job — skipping creation');
      } else {
        logger.error({ err, jobId: job.id }, '[internal] Failed to create model');
        // Non-fatal: job is already COMPLETED, continue
      }
    }

    // 5. Record usage — need userId from project
    try {
      const project = stateStore.getProjectById(job.projectId);
      if (project) {
        await stateStore.recordUsage({
          userId: project.userId,
          jobId: job.id,
          gpuHours: (body.duration_min ?? 0) / 60,
          costUSD: body.cost_usd ?? 0,
        });
      }
    } catch (err) {
      logger.error({ err, jobId: job.id }, '[internal] Failed to record usage');
      // Non-fatal: continue
    }

    // 6. Broadcast ShrikDB event (never blocks response)
    try {
      broadcastToJob(body.job_id, {
        event_type: 'training.completed',
        payload: {
          jobId: body.job_id,
          checkpointPath: body.checkpoint_path,
          finalLoss: body.final_loss,
          durationMin: body.duration_min,
          costUSD: body.cost_usd,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logger.error({ err, jobId: body.job_id }, '[internal] broadcastToJob failed');
    }

    // 7. Return
    logger.info({ jobId: body.job_id, modelId }, '[internal] Job completed');
    res.status(200).json({ received: true, modelId });
    return;

  } else {
    // ── FAILED flow ───────────────────────────────────

    // 3. Update job status
    try {
      await stateStore.updateJobStatus(body.job_id, {
        status: 'FAILED',
        errorMessage: body.error ?? 'Unknown error',
      });
    } catch (err) {
      logger.error({ err, jobId: body.job_id }, '[internal] Failed to update job status');
      res.status(500).json({ error: 'Failed to update job', code: 'INTERNAL_ERROR' });
      return;
    }

    // 4. Broadcast (never blocks response)
    try {
      broadcastToJob(body.job_id, {
        event_type: 'training.failed',
        payload: {
          jobId: body.job_id,
          error: body.error,
          step: job.currentStep,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logger.error({ err, jobId: body.job_id }, '[internal] broadcastToJob failed');
    }

    // 5. Return
    logger.info({ jobId: body.job_id, error: body.error }, '[internal] Job failed');
    res.status(200).json({ received: true });
    return;
  }
});

// ── POST /internal/events ───────────────────────────────────────────────────

router.post('/events', async (req: Request, res: Response): Promise<void> => {
  const parsed = eventsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input', code: 'INVALID_INPUT' });
    return;
  }

  const body = parsed.data;

  // If training.step — update job progress in state store
  if (body.event_type === 'training.step') {
    const step = typeof body.payload['step'] === 'number' ? body.payload['step'] as number : null;
    const totalSteps = typeof body.payload['totalSteps'] === 'number' ? body.payload['totalSteps'] as number : null;
    const loss = typeof body.payload['loss'] === 'number' ? body.payload['loss'] as number : undefined;

    if (step === null) {
      logger.warn({ jobId: body.job_id }, '[internal] training.step missing step field');
    } else {
      try {
        // Calculate progress — guard against totalSteps being 0 or null
        const progress = (totalSteps && totalSteps > 0)
          ? Math.round((step / totalSteps) * 100)
          : undefined;

        await stateStore.updateJobProgress(body.job_id, {
          progress: progress ?? 0,
          currentStep: step,
          ...(totalSteps !== null ? { totalSteps } : {}),
          ...(loss !== undefined ? { currentLoss: loss } : {}),
        });
      } catch (err) {
        // DB update failure must NOT fail broadcast
        logger.error({ err, jobId: body.job_id }, '[internal] Failed to update job progress');
      }
    }
  }

  // Broadcast to WebSocket clients (always, regardless of event_type)
  try {
    broadcastToJob(body.job_id, {
      event_type: body.event_type,
      payload: body.payload,
      timestamp: body.timestamp ?? new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err, jobId: body.job_id }, '[internal] broadcastToJob failed');
  }

  const clients = getConnectedClientCount(body.job_id);
  res.status(200).json({ broadcast: true, clients });
});

export default router;
