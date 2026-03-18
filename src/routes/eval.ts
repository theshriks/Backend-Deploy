import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
import type { Request, Response } from 'express';

const router = Router();
router.use(authenticate);

// ── GET /eval/:modelId ────────────────────────────────────────────────────────
// Response: { modelId, benchmarks: { mmlu, humaneval, mtbench, truthfulqa }, customEval }
router.get('/:modelId', async (req: Request, res: Response): Promise<void> => {
  const modelId = req.params['modelId'] as string;
  const userId = req.user!.userId;

  const model = await prisma.model.findUnique({
    where: { id: modelId },
    include: {
      project: { select: { userId: true } },
      evalResults: {
        select: { benchmark: true, score: true, metadata: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      },
    },
  }).catch((err: unknown) => {
    logger.error({ err, modelId }, 'DB error fetching eval results');
    return undefined;
  });

  if (model === undefined) { res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }); return; }
  if (!model) { res.status(404).json({ error: 'Model not found', code: 'NOT_FOUND' }); return; }
  if (model.project.userId !== userId) { res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' }); return; }

  // Build benchmark map from EvalResult rows
  const benchmarkMap: Record<string, number> = {};
  for (const r of model.evalResults) {
    benchmarkMap[r.benchmark] = r.score;
  }

  // Merge with any benchmarks stored directly on the model JSON field
  const storedBenchmarks =
    typeof model.benchmarks === 'object' && model.benchmarks !== null
      ? (model.benchmarks as Record<string, number>)
      : {};

  const merged = { ...storedBenchmarks, ...benchmarkMap };

  // Separate standard benchmarks from custom evals
  const STANDARD = new Set(['mmlu', 'humaneval', 'mtbench', 'truthfulqa']);
  const customResults = model.evalResults.filter((r) => !STANDARD.has(r.benchmark));

  // Build customEval as { passed, total } from custom eval metadata
  let customEval: { passed: number; total: number } | null = null;
  if (customResults.length > 0) {
    // Each custom eval result's metadata may contain pass/fail info
    let passed = 0;
    let total = 0;
    for (const r of customResults) {
      const meta = r.metadata as Record<string, unknown> | null;
      if (meta && typeof meta['passed'] === 'number' && typeof meta['total'] === 'number') {
        passed += meta['passed'] as number;
        total += meta['total'] as number;
      } else {
        // Fallback: treat each custom eval result as 1 test, score >= 0.5 = passed
        total += 1;
        if (r.score >= 0.5) passed += 1;
      }
    }
    customEval = { passed, total };
  }

  res.status(200).json({
    modelId,
    benchmarks: {
      mmlu: merged['mmlu'] ?? null,
      humaneval: merged['humaneval'] ?? null,
      mtbench: merged['mtbench'] ?? null,
      truthfulqa: merged['truthfulqa'] ?? null,
    },
    customEval,
  });
});

export default router;
