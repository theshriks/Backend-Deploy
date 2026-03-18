import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { stateStore } from '../lib/state-store';
import { logger } from '../lib/logger';
import type { Request, Response } from 'express';

const router = Router();
router.use(authenticate);

// ── GET /eval/:modelId ────────────────────────────────
router.get('/:modelId', (req: Request, res: Response): void => {
  const modelId = req.params['modelId'] as string;
  const userId = req.user!.userId;

  const model = stateStore.getModelById(modelId);
  if (!model) { res.status(404).json({ error: 'Model not found', code: 'NOT_FOUND' }); return; }

  const project = stateStore.getProjectById(model.projectId);
  if (!project || project.userId !== userId) {
    res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
    return;
  }

  const evalResults = stateStore.getEvalResultsByModel(modelId);

  // Build benchmark map from EvalResult records
  const benchmarkMap: Record<string, number> = {};
  for (const r of evalResults) {
    benchmarkMap[r.benchmark] = r.score;
  }

  // Merge with any benchmarks stored on the model
  const storedBenchmarks =
    typeof model.benchmarks === 'object' && model.benchmarks !== null
      ? (model.benchmarks as Record<string, number>)
      : {};

  const merged = { ...storedBenchmarks, ...benchmarkMap };

  // Separate standard benchmarks from custom evals
  const STANDARD = new Set(['mmlu', 'humaneval', 'mtbench', 'truthfulqa']);
  const customResults = evalResults.filter((r) => !STANDARD.has(r.benchmark));

  let customEval: { passed: number; total: number } | null = null;
  if (customResults.length > 0) {
    let passed = 0;
    let total = 0;
    for (const r of customResults) {
      const meta = r.metadata as Record<string, unknown> | null;
      if (meta && typeof meta['passed'] === 'number' && typeof meta['total'] === 'number') {
        passed += meta['passed'] as number;
        total += meta['total'] as number;
      } else {
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
