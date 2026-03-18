import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { stateStore } from '../lib/state-store';
import { logger } from '../lib/logger';
import type { Request, Response } from 'express';

const router = Router();
router.use(authenticate);

const createProjectSchema = z.object({
  name: z.string().min(1, 'Project name is required').max(100),
});

// ── GET /projects ─────────────────────────────────────
// Response: [{ id, name, createdAt, modelCount, jobCount }]
router.get('/', (req: Request, res: Response): void => {
  const userId = req.user!.userId;

  const projects = stateStore.getProjectsByUser(userId);

  // Compute counts from in-memory state
  const result = projects
    .map((p) => {
      const models = stateStore.getModelsByProject(p.id);
      const jobs = stateStore.getJobsByProject(p.id);
      return {
        id: p.id,
        name: p.name,
        createdAt: p.createdAt,
        modelCount: models.length,
        jobCount: jobs.length,
      };
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  res.status(200).json(result);
});

// ── POST /projects ────────────────────────────────────
// Response: { id, name, createdAt }
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const parsed = createProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input', code: 'INVALID_INPUT' });
    return;
  }

  const userId = req.user!.userId;

  try {
    const project = await stateStore.createProject({ name: parsed.data.name, userId });

    logger.info({ userId, projectId: project.id }, 'Project created');
    res.status(201).json({ id: project.id, name: project.name, createdAt: project.createdAt });
  } catch (err: unknown) {
    logger.error({ err, userId }, 'Error creating project');
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

export default router;
