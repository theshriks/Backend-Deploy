import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import prisma from '../lib/prisma';
import { Prisma } from '@prisma/client';
import logger from '../lib/logger';
import type { Request, Response } from 'express';

const router = Router();
router.use(authenticate);

const guardrailBodySchema = z.object({
  modelId: z.string().min(1, 'modelId is required'),
  rules: z.record(z.string(), z.unknown()),
});

// ── POST /guardrails ──────────────────────────────────────────────────────────
// Upsert guardrail config for a model (one per model)
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.userId;

  const parsed = guardrailBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input', code: 'INVALID_INPUT' });
    return;
  }

  const { modelId, rules } = parsed.data;

  // Verify model exists and belongs to user
  const model = await prisma.model.findUnique({
    where: { id: modelId },
    include: { project: { select: { userId: true } } },
  }).catch((err: unknown) => { logger.error({ err }, 'DB error'); return undefined; });

  if (model === undefined) { res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }); return; }
  if (!model) { res.status(404).json({ error: 'Model not found', code: 'NOT_FOUND' }); return; }
  if (model.project.userId !== userId) { res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' }); return; }

  // Upsert — one guardrail per model (@@unique([modelId]))
  const guardrail = await prisma.guardrail.upsert({
    where: { modelId },
    update: { rules: rules as Prisma.InputJsonValue },
    create: { modelId, rules: rules as Prisma.InputJsonValue },
  }).catch((err: unknown) => { logger.error({ err, modelId }, 'DB error upserting guardrail'); return null; });

  if (!guardrail) { res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }); return; }

  logger.info({ userId, modelId, guardrailId: guardrail.id }, 'Guardrail config saved');
  res.status(200).json({
    id: guardrail.id,
    modelId: guardrail.modelId,
    rules: guardrail.rules,
    createdAt: guardrail.createdAt,
    updatedAt: guardrail.updatedAt,
  });
});

// ── GET /guardrails/:modelId ──────────────────────────────────────────────────
router.get('/:modelId', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.userId;
  const modelId = req.params['modelId'] as string;

  // Verify model exists and belongs to user
  const model = await prisma.model.findUnique({
    where: { id: modelId },
    include: { project: { select: { userId: true } } },
  }).catch((err: unknown) => { logger.error({ err }, 'DB error'); return undefined; });

  if (model === undefined) { res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }); return; }
  if (!model) { res.status(404).json({ error: 'Model not found', code: 'NOT_FOUND' }); return; }
  if (model.project.userId !== userId) { res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' }); return; }

  const guardrail = await prisma.guardrail.findUnique({
    where: { modelId },
  }).catch((err: unknown) => { logger.error({ err, modelId }, 'DB error'); return undefined; });

  if (guardrail === undefined) { res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }); return; }
  if (!guardrail) {
    res.status(404).json({ error: 'No guardrail config found for this model', code: 'NOT_FOUND' });
    return;
  }

  res.status(200).json({
    id: guardrail.id,
    modelId: guardrail.modelId,
    rules: guardrail.rules,
    createdAt: guardrail.createdAt,
    updatedAt: guardrail.updatedAt,
  });
});

export default router;
