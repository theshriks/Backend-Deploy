import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
import type { Request, Response } from 'express';

const router = Router();
router.use(authenticate);

const createProjectSchema = z.object({
  name: z.string().min(1, 'Project name is required').max(100),
});

// ── GET /projects ─────────────────────────────────────────────────────────────
// Response: [{ id, name, createdAt, modelCount, jobCount }]
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.userId;

  const projects = await prisma.project.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      createdAt: true,
      _count: {
        select: { models: true, jobs: true },
      },
    },
  }).catch((err: unknown) => {
    logger.error({ err, userId }, 'DB error listing projects');
    return null;
  });

  if (projects === null) {
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    return;
  }

  res.status(200).json(
    projects.map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      modelCount: p._count.models,
      jobCount: p._count.jobs,
    })),
  );
});

// ── POST /projects ────────────────────────────────────────────────────────────
// Response: { id, name, createdAt }
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const parsed = createProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input', code: 'INVALID_INPUT' });
    return;
  }

  const userId = req.user!.userId;

  const project = await prisma.project.create({
    data: { name: parsed.data.name, userId },
    select: { id: true, name: true, createdAt: true },
  }).catch((err: unknown) => {
    logger.error({ err, userId }, 'DB error creating project');
    return null;
  });

  if (!project) {
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    return;
  }

  logger.info({ userId, projectId: project.id }, 'Project created');
  res.status(201).json(project);
});

export default router;
