import { Router } from 'express';
import archiver from 'archiver';
import { Readable } from 'stream';
import { authenticate } from '../middleware/authenticate';
import { authorize } from '../middleware/authorize';
import { BUCKETS, listObjects, getFileStream } from '../lib/minio';
import { stateStore } from '../lib/state-store';
import { logger } from '../lib/logger';
import type { Request, Response } from 'express';

const router = Router();
router.use(authenticate);

// ── GET /compliance/:modelId/download ─────────────────
router.get(
  '/:modelId/download',
  authorize('COMPLIANCE', 'EXECUTIVE'),
  async (req: Request, res: Response): Promise<void> => {
    const modelId = req.params['modelId'] as string;
    const userId = req.user!.userId;

    const model = stateStore.getModelById(modelId);
    if (!model) { res.status(404).json({ error: 'Model not found', code: 'NOT_FOUND' }); return; }

    const project = stateStore.getProjectById(model.projectId);
    if (!project || project.userId !== userId) {
      res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
      return;
    }

    const prefix = `${modelId}/`;
    let objectList: string[];
    try {
      objectList = await new Promise<string[]>((resolve, reject) => {
        const objects: string[] = [];
        const stream = listObjects(BUCKETS.COMPLIANCE_DOCS, prefix, true);
        stream.on('data', (obj) => { if (obj.name) objects.push(obj.name); });
        stream.on('error', (err: unknown) => reject(err));
        stream.on('end', () => resolve(objects));
      });
    } catch (err) {
      logger.error({ err, modelId }, 'MinIO error listing compliance docs');
      res.status(500).json({ error: 'Storage error', code: 'STORAGE_ERROR' });
      return;
    }

    const safeName = model.name.replace(/[^a-z0-9_-]/gi, '_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="compliance-${safeName}-v${model.version}.zip"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => {
      logger.error({ err, modelId }, 'Archiver error during compliance zip');
    });
    archive.pipe(res);

    for (const objectName of objectList) {
      try {
        const fileStream = await getFileStream(BUCKETS.COMPLIANCE_DOCS, objectName);
        const fileName = objectName.replace(prefix, '');
        archive.append(fileStream as unknown as Readable, { name: fileName });
      } catch (err) {
        logger.warn({ err, objectName }, 'Skipping compliance doc — fetch failed');
      }
    }

    await archive.finalize();
    logger.info({ userId, modelId, docCount: objectList.length }, 'Compliance ZIP streamed');
  },
);

export default router;
