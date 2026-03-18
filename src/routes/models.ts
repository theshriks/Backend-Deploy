import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { authenticate } from '../middleware/authenticate';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
import type { Request, Response } from 'express';

const router = Router();
router.use(authenticate);

const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL ?? '';

const modelsQuerySchema = z.object({
  projectId: z.string().uuid('Invalid project ID'),
});

// ── GET /models ───────────────────────────────────────────────────────────────
// Response: [{ id, name, version, baseModel, benchmarks, deployedAt, status }]
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.userId;

  const parsed = modelsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'projectId query parameter is required', code: 'INVALID_INPUT' });
    return;
  }

  const { projectId } = parsed.data;

  // Verify project exists and belongs to user
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { userId: true },
  }).catch((err: unknown) => {
    logger.error({ err }, 'DB error verifying project');
    return undefined;
  });

  if (project === undefined) { res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }); return; }
  if (!project) { res.status(404).json({ error: 'Project not found', code: 'NOT_FOUND' }); return; }
  if (project.userId !== userId) { res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' }); return; }

  const models = await prisma.model.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, name: true, version: true,
      baseModel: true, benchmarks: true, deployedAt: true, status: true,
    },
  }).catch((err: unknown) => { logger.error({ err }, 'DB error'); return null; });

  if (models === null) { res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }); return; }

  res.status(200).json(
    models.map((m) => ({
      id: m.id,
      name: m.name,
      version: m.version,
      baseModel: m.baseModel,
      benchmarks: m.benchmarks ?? {},
      deployedAt: m.deployedAt,
      status: m.status.toLowerCase(),
    })),
  );
});

// ── POST /models/:id/deploy ───────────────────────────────────────────────────
router.post(
  '/:id/deploy',
  async (req: Request, res: Response): Promise<void> => {
    const modelId = req.params['id'] as string;
    const userId = req.user!.userId;

    const model = await prisma.model.findUnique({
      where: { id: modelId },
      include: {
        project: { select: { userId: true } },
        deployment: { select: { id: true, status: true } },
      },
    }).catch((err: unknown) => { logger.error({ err }, 'DB error'); return undefined; });

    if (model === undefined) { res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }); return; }
    if (!model) { res.status(404).json({ error: 'Model not found', code: 'NOT_FOUND' }); return; }
    if (model.project.userId !== userId) { res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' }); return; }
    if (model.deployment?.status === 'live') { res.status(409).json({ error: 'Model is already deployed', code: 'CONFLICT' }); return; }
    if (!['TRAINED', 'EVALUATED'].includes(model.status)) {
      res.status(409).json({ error: `Model in status ${model.status} cannot be deployed`, code: 'CONFLICT' });
      return;
    }

    // ── CI Gate — check benchmarks before deploy ───────────────────────────
    if (!model.benchmarks) {
      res.status(422).json({
        error: 'Model has not been evaluated. Run eval benchmarks before deploying.',
        code: 'CI_GATE_FAILED',
        scores: null,
      });
      return;
    }

    const benchmarks = model.benchmarks as {
      mmlu?: number; humaneval?: number;
      mtbench?: number; truthfulqa?: number;
    };

    if (Object.keys(benchmarks).length === 0) {
      res.status(422).json({
        error: 'Model has not been evaluated. Run eval benchmarks before deploying.',
        code: 'CI_GATE_FAILED',
        scores: null,
      });
      return;
    }

    const parsedThreshold = parseFloat(process.env.CI_DEPLOY_THRESHOLD ?? '0.3');
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
    // ── End CI Gate ────────────────────────────────────────────────────────

    await prisma.model.update({ where: { id: modelId }, data: { status: 'DEPLOYING' } });

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
      await prisma.model.update({ where: { id: modelId }, data: { status: 'TRAINED' } });
      res.status(502).json({ error: 'Deployment service unavailable', code: 'PYTHON_SERVICE_ERROR' });
      return;
    }

    // apiKey shown ONCE — store SHA-256 hash only (memory anchor #6)
    const rawApiKey = `mf_${crypto.randomBytes(32).toString('hex')}`;
    const apiKeyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex');
    const apiUrl = `https://api.theshriks.space/infer/${modelId}`;

    await prisma.deployment.upsert({
      where: { modelId },
      create: { modelId, apiUrl, apiKey: apiKeyHash, nimImagePath: nimResponse.nimImagePath, latencyMs: 120, status: 'live' },
      update: { apiUrl, apiKey: apiKeyHash, nimImagePath: nimResponse.nimImagePath, latencyMs: 120, status: 'live' },
    });

    await prisma.model.update({ where: { id: modelId }, data: { status: 'DEPLOYED', deployedAt: new Date() } });

    logger.info({ userId, modelId }, 'Model deployed');
    // Fix 6: return 200 per API contract spec (not 201)
    res.status(200).json({ apiUrl, apiKey: rawApiKey, latencyMs: 120, status: 'live' });
  },
);

export default router;
