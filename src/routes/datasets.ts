import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { uploadLimiter } from '../middleware/rateLimiter';
import { datasetUploadSchema } from '../schemas/dataset.schema';
import { BUCKETS, putObjectStream } from '../lib/minio';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
import { Readable } from 'stream';
import multer from 'multer';
import type { Request, Response } from 'express';

const router = Router();
router.use(authenticate);

// ── Multer: memory storage with 25MB limit ─────────────────────────────────
const SUPPORTED_MIME_TYPES = new Set([
  'text/csv',
  'application/json',
  'application/pdf',
  'text/plain',
]);
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB — Railway free tier has 256MB RAM

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (SUPPORTED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: CSV, JSON, PDF, TXT`));
    }
  },
});

// Wrap multer.single in a Promise for use in async handlers
function runMulter(req: Request, res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    upload.single('file')(req, res, (err) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: 'File too large. Maximum size is 25MB', code: 'FILE_TOO_LARGE' });
        resolve();
        return;
      }
      if (err instanceof Error) {
        res.status(400).json({ error: err.message, code: 'INVALID_INPUT' });
        resolve();
        return;
      }
      if (err != null) { reject(new Error(String(err))); return; }
      resolve();
    });
  });
}

// ── sampleCount extraction ──────────────────────────────────────────────────
function extractSampleCount(buffer: Buffer, mimetype: string): number {
  try {
    if (mimetype === 'application/json') {
      const parsed: unknown = JSON.parse(buffer.toString('utf8'));
      return Array.isArray(parsed) ? parsed.length : 1;
    }
    if (mimetype === 'text/csv' || mimetype === 'text/plain') {
      const lines = buffer.toString('utf8').split('\n').filter((l) => l.trim().length > 0);
      return Math.max(0, lines.length - 1);
    }
    if (mimetype === 'application/pdf') {
      return Math.max(1, Math.floor(buffer.length / 800));
    }
  } catch {
    // non-fatal — default to 0
  }
  return 0;
}

// ── POST /datasets/upload ───────────────────────────────────────────────────
// Response: { datasetId, fileName, sampleCount, qualityScore }
router.post('/upload', uploadLimiter, async (req: Request, res: Response): Promise<void> => {
  await runMulter(req, res);
  if (res.headersSent) return;

  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded', code: 'INVALID_INPUT' });
    return;
  }

  const parsed = datasetUploadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input', code: 'INVALID_INPUT' });
    return;
  }

  const { projectId } = parsed.data;
  const userId = req.user!.userId;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, userId: true },
  }).catch((err: unknown) => {
    logger.error({ err }, 'DB error verifying project');
    return undefined;
  });

  if (project === undefined) {
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    return;
  }
  if (!project) {
    res.status(404).json({ error: 'Project not found', code: 'NOT_FOUND' });
    return;
  }
  if (project.userId !== userId) {
    res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
    return;
  }

  const dataset = await prisma.dataset.create({
    data: {
      projectId,
      fileName: req.file.originalname,
      fileType: req.file.mimetype,
      minioPath: '',
      sampleCount: 0,
      qualityScore: 0,
    },
    select: { id: true },
  }).catch((err: unknown) => {
    logger.error({ err }, 'DB error creating dataset record');
    return null;
  });

  if (!dataset) {
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    return;
  }

  const minioPath = `${dataset.id}/${req.file.originalname}`;
  const fileStream = Readable.from(req.file.buffer);

  try {
    await putObjectStream(
      BUCKETS.DATASETS,
      minioPath,
      fileStream,
      req.file.size,
      { 'Content-Type': req.file.mimetype },
    );
  } catch (err) {
    logger.error({ err, datasetId: dataset.id }, 'MinIO upload failed — rolling back DB record');
    await prisma.dataset.delete({ where: { id: dataset.id } }).catch(() => null);
    res.status(500).json({ error: 'File upload failed', code: 'STORAGE_ERROR' });
    return;
  }

  const sampleCount = extractSampleCount(req.file.buffer, req.file.mimetype);
  const qualityScore = sampleCount > 0 ? Math.min(100, sampleCount / 10) : 0;

  const updated = await prisma.dataset.update({
    where: { id: dataset.id },
    data: { minioPath, sampleCount, qualityScore },
    select: { id: true, fileName: true, sampleCount: true, qualityScore: true },
  }).catch((err: unknown) => {
    logger.error({ err, datasetId: dataset.id }, 'DB error updating dataset after upload');
    return null;
  });

  if (!updated) {
    logger.error({ datasetId: dataset.id }, 'Dataset uploaded to MinIO but DB update failed');
  }

  logger.info({ userId, projectId, datasetId: dataset.id, sampleCount }, 'Dataset uploaded');
  res.status(201).json({
    datasetId: dataset.id,
    fileName: req.file.originalname,
    sampleCount: updated?.sampleCount ?? sampleCount,
    qualityScore: updated?.qualityScore ?? qualityScore,
  });
});

// ── GET /datasets ───────────────────────────────────────────────────────────
// Response: [{ id, name, sampleCount, qualityScore, createdAt }]
const datasetQuerySchema = z.object({
  projectId: z.string().uuid('Invalid project ID'),
});

router.get('/', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.userId;

  const parsed = datasetQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'projectId query parameter is required', code: 'INVALID_INPUT' });
    return;
  }

  const { projectId } = parsed.data;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { userId: true },
  }).catch((err: unknown) => {
    logger.error({ err }, 'DB error verifying project');
    return undefined;
  });

  if (project === undefined) {
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    return;
  }
  if (!project) {
    res.status(404).json({ error: 'Project not found', code: 'NOT_FOUND' });
    return;
  }
  if (project.userId !== userId) {
    res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
    return;
  }

  const datasets = await prisma.dataset.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      fileName: true,
      sampleCount: true,
      qualityScore: true,
      createdAt: true,
    },
  }).catch((err: unknown) => {
    logger.error({ err, userId }, 'DB error listing datasets');
    return null;
  });

  if (datasets === null) {
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    return;
  }

  res.status(200).json(
    datasets.map((d) => ({
      id: d.id,
      name: d.fileName,
      sampleCount: d.sampleCount,
      qualityScore: d.qualityScore,
      createdAt: d.createdAt,
    })),
  );
});

export default router;
