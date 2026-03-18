import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { stateStore } from '../lib/state-store';
import { logger } from '../lib/logger';
import type { Request, Response } from 'express';

const router = Router();
router.use(authenticate);

const guardrailBodySchema = z.object({
  modelId: z.string().min(1, 'modelId is required'),
  rules: z.record(z.string(), z.unknown()),
});

// ── POST /guardrails ──────────────────────────────────
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.userId;

  const parsed = guardrailBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input', code: 'INVALID_INPUT' });
    return;
  }

  const { modelId, rules } = parsed.data;

  const model = stateStore.getModelById(modelId);
  if (!model) { res.status(404).json({ error: 'Model not found', code: 'NOT_FOUND' }); return; }

  const project = stateStore.getProjectById(model.projectId);
  if (!project || project.userId !== userId) {
    res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
    return;
  }

  try {
    const guardrail = await stateStore.upsertGuardrail({ modelId, rules: rules as Record<string, unknown> });

    logger.info({ userId, modelId, guardrailId: guardrail.id }, 'Guardrail config saved');
    res.status(200).json({
      id: guardrail.id,
      modelId: guardrail.modelId,
      rules: guardrail.rules,
      createdAt: guardrail.createdAt,
      updatedAt: guardrail.updatedAt,
    });
  } catch (err: unknown) {
    logger.error({ err, modelId }, 'Error upserting guardrail');
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// ── GET /guardrails/:modelId ──────────────────────────
router.get('/:modelId', (req: Request, res: Response): void => {
  const userId = req.user!.userId;
  const modelId = req.params['modelId'] as string;

  const model = stateStore.getModelById(modelId);
  if (!model) { res.status(404).json({ error: 'Model not found', code: 'NOT_FOUND' }); return; }

  const project = stateStore.getProjectById(model.projectId);
  if (!project || project.userId !== userId) {
    res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
    return;
  }

  const guardrail = stateStore.getGuardrailByModel(modelId);
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
