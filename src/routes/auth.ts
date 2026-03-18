import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { authLimiter } from '../middleware/rateLimiter';
import { signupSchema, loginSchema, refreshSchema } from '../schemas/auth.schema';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
import type { Request, Response } from 'express';

const router = Router();
router.use(authLimiter);

const BCRYPT_ROUNDS = 12;
const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL = '7d';
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const JWT_SECRET = process.env.JWT_SECRET ?? '';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? '';

// Pre-computed valid bcrypt hash for constant-time comparison on failed lookups
// Computed once at module load — never blocks event loop during requests
const DUMMY_HASH = bcrypt.hashSync('dummy-never-matches', BCRYPT_ROUNDS);

function signAccessToken(userId: string, email: string, role: string): string {
  return jwt.sign({ userId, email, role }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}

function signRefreshToken(userId: string): string {
  return jwt.sign({ userId }, JWT_REFRESH_SECRET, { expiresIn: REFRESH_TOKEN_TTL });
}

// ── POST /auth/signup ─────────────────────────────────────────────────────────
// Response: { accessToken, refreshToken, user: { id, name, email } }
router.post('/signup', async (req: Request, res: Response): Promise<void> => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input', code: 'INVALID_INPUT' });
    return;
  }

  const { name, email, password, role } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } }).catch((err: unknown) => {
    logger.error({ err }, 'DB error on signup lookup');
    return undefined;
  });

  if (existing === undefined) {
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    return;
  }
  if (existing !== null) {
    res.status(409).json({ error: 'Email already registered', code: 'CONFLICT' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const user = await prisma.user.create({
    data: { name, email, passwordHash, role },
    select: { id: true, name: true, email: true, role: true },
  }).catch((err: unknown) => {
    logger.error({ err }, 'DB error creating user');
    return null;
  });

  if (!user) {
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    return;
  }

  const accessToken = signAccessToken(user.id, user.email, user.role);
  const refreshToken = signRefreshToken(user.id);

  await prisma.refreshToken.create({
    data: {
      token: refreshToken,
      userId: user.id,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    },
  }).catch((err: unknown) => logger.error({ err }, 'Failed to store refresh token'));

  logger.info({ userId: user.id }, 'User signed up');
  res.status(201).json({
    accessToken,
    refreshToken,
    user: { id: user.id, name: user.name, email: user.email },
  });
});

// ── POST /auth/login ──────────────────────────────────────────────────────────
// Response: { accessToken, refreshToken, user: { id, name, email } }
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input', code: 'INVALID_INPUT' });
    return;
  }

  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } }).catch((err: unknown) => {
    logger.error({ err }, 'DB error on login lookup');
    return undefined;
  });

  // Constant-time: always run bcrypt to prevent timing attacks on email enumeration
  const hashToCompare = user?.passwordHash ?? DUMMY_HASH;
  const passwordMatch = await bcrypt.compare(password, hashToCompare);

  if (user === undefined) {
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    return;
  }
  if (!user || !passwordMatch) {
    res.status(401).json({ error: 'Invalid email or password', code: 'UNAUTHORIZED' });
    return;
  }

  const accessToken = signAccessToken(user.id, user.email, user.role);
  const refreshToken = signRefreshToken(user.id);

  await prisma.refreshToken.create({
    data: {
      token: refreshToken,
      userId: user.id,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    },
  }).catch((err: unknown) => logger.error({ err }, 'Failed to store refresh token'));

  logger.info({ userId: user.id }, 'User logged in');
  res.status(200).json({
    accessToken,
    refreshToken,
    user: { id: user.id, name: user.name, email: user.email },
  });
});

// ── POST /auth/refresh ────────────────────────────────────────────────────────
// Response: { accessToken }
router.post('/refresh', async (req: Request, res: Response): Promise<void> => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Refresh token required', code: 'INVALID_INPUT' });
    return;
  }

  const { refreshToken } = parsed.data;

  // Verify JWT signature first — catches tampered and expired tokens
  let payload: { userId: string };
  try {
    payload = jwt.verify(refreshToken, JWT_REFRESH_SECRET) as { userId: string };
  } catch {
    res.status(401).json({ error: 'Invalid or expired token', code: 'UNAUTHORIZED' });
    return;
  }

  // Look up token record in DB
  const tokenRecord = await prisma.refreshToken.findUnique({
    where: { token: refreshToken },
  }).catch((err: unknown) => {
    logger.error({ err }, 'DB error on refresh token lookup');
    return undefined;
  });

  if (tokenRecord === undefined) {
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    return;
  }

  // SECURITY: Token reuse detection → invalidate entire session
  if (!tokenRecord || tokenRecord.used) {
    if (tokenRecord?.used) {
      // Invalidate all tokens for this user — session has been compromised
      await prisma.refreshToken.updateMany({
        where: { userId: payload.userId },
        data: { used: true },
      }).catch((err: unknown) => logger.error({ err }, 'Failed to invalidate compromised session'));
      logger.warn({ userId: payload.userId }, 'Refresh token reuse detected — session invalidated');
    }
    res.status(401).json({ error: 'Invalid or expired token', code: 'UNAUTHORIZED' });
    return;
  }

  if (new Date() > tokenRecord.expiresAt) {
    res.status(401).json({ error: 'Invalid or expired token', code: 'UNAUTHORIZED' });
    return;
  }

  // Fetch user to issue new access token
  const user = await prisma.user.findUnique({
    where: { id: tokenRecord.userId },
    select: { id: true, email: true, role: true },
  }).catch((err: unknown) => {
    logger.error({ err }, 'DB error fetching user on refresh');
    return null;
  });

  if (!user) {
    res.status(401).json({ error: 'Invalid or expired token', code: 'UNAUTHORIZED' });
    return;
  }

  // Rotate: mark old token used
  await prisma.refreshToken.update({
    where: { token: refreshToken },
    data: { used: true },
  }).catch((err: unknown) => logger.error({ err }, 'Failed to mark refresh token used'));

  const accessToken = signAccessToken(user.id, user.email, user.role);

  logger.info({ userId: user.id }, 'Access token refreshed');
  res.status(200).json({ accessToken });
});

export default router;
