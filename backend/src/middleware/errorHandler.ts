import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import logger from '../lib/logger';

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');

  if (err instanceof ZodError) {
    res.status(400).json({
      error: err.issues[0]?.message ?? 'Invalid input',
      code: 'INVALID_INPUT',
    });
    return;
  }

  const status = (err as Error & { status?: number }).status ?? 500;
  const code = (err as Error & { code?: string }).code ?? 'INTERNAL_ERROR';

  res.status(status).json({
    error: status === 500 ? 'Internal server error' : err.message,
    code,
  });
}
