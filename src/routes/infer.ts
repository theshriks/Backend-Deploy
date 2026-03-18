import { Router } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
import type { Request, Response } from 'express';

const router = Router();

// Rate limit by apiKey (per spec §9: "Rate limit per apiKey, not per IP")
const inferLimiter = rateLimit({
  windowMs: 60 * 1_000,
  limit: 60,
  keyGenerator: (req) => {
    // Extract apiKey from Authorization: Bearer {apiKey}
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }
    return req.ip ?? 'unknown';
  },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  validate: false, // Express 5 false-positive on custom keyGenerator
  message: { error: 'Rate limit exceeded', code: 'RATE_LIMITED' },
});

// ── POST /infer/:deploymentId ─────────────────────────────────────────────────
router.post('/:deploymentId', inferLimiter, async (req: Request, res: Response): Promise<void> => {
  const deploymentId = req.params['deploymentId'] as string;

  // Extract apiKey from Authorization: Bearer {apiKey}
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'API key required. Use Authorization: Bearer {apiKey}', code: 'UNAUTHORIZED' });
    return;
  }
  const rawApiKey = authHeader.slice(7);
  if (!rawApiKey) {
    res.status(401).json({ error: 'API key required', code: 'UNAUTHORIZED' });
    return;
  }

  const apiKeyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex');

  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    include: { model: { select: { id: true, name: true, status: true } } },
  }).catch((err: unknown) => {
    logger.error({ err, deploymentId }, 'DB error fetching deployment');
    return undefined;
  });

  if (deployment === undefined) { res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }); return; }
  if (!deployment) { res.status(404).json({ error: 'Deployment not found', code: 'NOT_FOUND' }); return; }

  // Constant-time comparison — prevents timing attacks
  const hashBuffer = Buffer.from(apiKeyHash);
  const storedBuffer = Buffer.from(deployment.apiKey);
  if (hashBuffer.length !== storedBuffer.length || !crypto.timingSafeEqual(hashBuffer, storedBuffer)) {
    res.status(401).json({ error: 'Invalid API key', code: 'UNAUTHORIZED' });
    return;
  }

  if (deployment.status !== 'live') {
    res.status(503).json({ error: 'Deployment is not live', code: 'CONFLICT' });
    return;
  }

  const startTime = Date.now();

  try {
    const upstream = await fetch(deployment.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!upstream.ok) {
      logger.error({ deploymentId, status: upstream.status }, 'NIM upstream error');
      res.status(502).json({ error: 'Upstream inference error', code: 'PYTHON_SERVICE_ERROR' });
      return;
    }

    const data = await upstream.json() as { response: string; tokensUsed: number };
    const latencyMs = Date.now() - startTime;

    logger.info({ deploymentId, latencyMs, tokensUsed: data.tokensUsed }, 'Inference request served');
    res.status(200).json({
      response: data.response,
      tokensUsed: data.tokensUsed,
      latencyMs,
      model: deployment.model.name,
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'TimeoutError';
    logger.error({ err, deploymentId }, isTimeout ? 'NIM timeout' : 'NIM proxy error');
    res.status(isTimeout ? 504 : 502).json({
      error: isTimeout ? 'Inference timeout' : 'Inference service error',
      code: 'PYTHON_SERVICE_ERROR',
    });
  }
});

export default router;
