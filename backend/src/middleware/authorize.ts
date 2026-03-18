import type { Request, Response, NextFunction } from 'express';

type Role = 'RESEARCHER' | 'SAFETY_ADMIN' | 'COMPLIANCE' | 'EXECUTIVE';

export function authorize(...allowedRoles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED' });
      return;
    }

    if (!allowedRoles.includes(req.user.role as Role)) {
      res.status(403).json({ error: 'Insufficient permissions', code: 'FORBIDDEN' });
      return;
    }

    next();
  };
}
