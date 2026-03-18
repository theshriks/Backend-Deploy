import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { authenticate } from '../middleware/authenticate';
import { stateStore } from '../lib/state-store';
import { logger } from '../lib/logger';
import type { Request, Response } from 'express';

const router = Router();
router.use(authenticate);

const PYTHON_SERVICE_URL = process.env['PYTHON_SERVICE_URL'] ?? '';

const modelsQuerySchema = z.object({
  projectId: z.string().uuid('Invalid project ID'),
});

// ── GET /models ───────────────────────────────────────
router.get('/', (req: Request, res: Response): void => {
  const userId = req.user!.userId;

  const parsed = modelsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'projectId query parameter is required', code: 'INVALID_INPUT' });
    return;
  }

  const { projectId } = parsed.data;

  const project = stateStore.getProjectById(projectId);
  if (!project) { res.status(404).json({ error: 'Project not found', code: 'NOT_FOUND' }); return; }
  if (project.userId !== userId) { res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' }); return; }

  const models = stateStore.getModelsByProject(projectId)
    .map((m) => ({
      id: m.id,
      name: m.name,
      version: m.version,
      baseModel: m.baseModel,
      benchmarks: m.benchmarks ?? {},
      deployedAt: m.deployedAt,
      status: m.status.toLowerCase(),
    }))
    .sort((a, b) => new Date(b.deployedAt ?? b.status).getTime() - new Date(a.deployedAt ?? a.status).getTime());

  res.status(200).json(models);
});

// ── POST /models/:id/deploy ───────────────────────────
router.post('/:id/deploy', async (req: Request, res: Response): Promise<void> => {
  const modelId = req.params['id'] as string;
  const userId = req.user!.userId;

  const model = stateStore.getModelById(modelId);
  if (!model) { res.status(404).json({ error: 'Model not found', code: 'NOT_FOUND' }); return; }

  const project = stateStore.getProjectById(model.projectId);
  if (!project || project.userId !== userId) { res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' }); return; }

  const existingDeployment = stateStore.getDeploymentByModelId(modelId);
  if (existingDeployment?.status === 'live') {
    res.status(409).json({ error: 'Model is already deployed', code: 'CONFLICT' });
    return;
  }

  if (!['TRAINED', 'EVALUATED'].includes(model.status)) {
    res.status(409).json({ error: `Model in status ${model.status} cannot be deployed`, code: 'CONFLICT' });
    return;
  }

  // ── CI Gate — check benchmarks before deploy ─────
  if (!model.benchmarks || Object.keys(model.benchmarks).length === 0) {
    res.status(422).json({
      error: 'Model has not been evaluated. Run eval benchmarks before deploying.',
      code: 'CI_GATE_FAILED',
      scores: null,
    });
    return;
  }

  const benchmarks = model.benchmarks as Record<string, number>;
  const parsedThreshold = parseFloat(process.env['CI_DEPLOY_THRESHOLD'] ?? '0.3');
  const CI_THRESHOLD = Number.isNaN(parsedThreshold) ? 0.3 : parsedThreshold;

  const failingBenchmarks = Object.entries(benchmarks)
    .filter(([, score]) => typeof score === 'number' && score < CI_THRESHOLD)
    .map(([name, score]) => ({ benchmark: name, score }));

  if (failingBenchmarks.length > 0) {
    res.status(422).json({
      error: `Model benchmarks below deployment threshold (${CI_THRESHOLD}). Review scores before deploying.`,
      code: 'CI_GATE_FAILED',
      failing: failingBenchmarks,
      allScores: benchmarks,
    });
    return;
  }

  await stateStore.updateModelStatus(modelId, { status: 'DEPLOYING' });

  let nimResponse: { nimImagePath: string; apiPort: number; status: string };
  try {
    const r = await fetch(`${PYTHON_SERVICE_URL}/nemo/nim-pack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId, checkpointPath: model.checkpointPath }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error(`nim-pack returned ${r.status}`);
    nimResponse = await r.json() as typeof nimResponse;
  } catch (err) {
    logger.error({ err, modelId }, 'nim-pack call failed');
    await stateStore.updateModelStatus(modelId, { status: 'TRAINED' });
    res.status(502).json({ error: 'Deployment service unavailable', code: 'PYTHON_SERVICE_ERROR' });
    return;
  }

  // apiKey shown ONCE — store SHA-256 hash only
  const rawApiKey = `mf_${crypto.randomBytes(32).toString('hex')}`;
  const apiKeyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex');
  const apiUrl = `https://api.theshriks.space/infer/${modelId}`;

  try {
    await stateStore.createDeployment({
      modelId,
      apiUrl,
      apiKey: apiKeyHash,
      nimImagePath: nimResponse.nimImagePath,
      latencyMs: 120,
      status: 'live',
    });
  } catch (err: unknown) {
    const error = err as { status?: number };
    if (error.status === 409) {
      // Deployment exists — update it
      const existing = stateStore.getDeploymentByModelId(modelId);
      if (existing) {
        await stateStore.updateDeployment(existing.id, { status: 'live', apiUrl, latencyMs: 120 });
      }
    } else {
      logger.error({ err, modelId }, 'Error creating deployment');
      res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
      return;
    }
  }

  await stateStore.updateModelStatus(modelId, { status: 'DEPLOYED', deployedAt: new Date().toISOString() });

  logger.info({ userId, modelId }, 'Model deployed');
  res.status(200).json({ apiUrl, apiKey: rawApiKey, latencyMs: 120, status: 'live' });
});

export default router;
