import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { authLimiter } from '../middleware/rateLimiter';
import { signupSchema, loginSchema, refreshSchema } from '../schemas/auth.schema';
import { stateStore } from '../lib/state-store';
import { logger } from '../lib/logger';
import type { Request, Response } from 'express';

const router = Router();
router.use(authLimiter);

const BCRYPT_ROUNDS = 12;
const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL = '7d';
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const JWT_SECRET = process.env['JWT_SECRET'] ?? '';
const JWT_REFRESH_SECRET = process.env['JWT_REFRESH_SECRET'] ?? '';

const DUMMY_HASH = bcrypt.hashSync('dummy-never-matches', BCRYPT_ROUNDS);

function signAccessToken(userId: string, email: string, role: string): string {
  return jwt.sign({ userId, email, role }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}

function signRefreshToken(userId: string): string {
  return jwt.sign({ userId }, JWT_REFRESH_SECRET, { expiresIn: REFRESH_TOKEN_TTL });
}

// ── POST /auth/signup ─────────────────────────────────
router.post('/signup', async (req: Request, res: Response): Promise<void> => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input', code: 'INVALID_INPUT' });
    return;
  }

  const { name, email, password, role } = parsed.data;

  // Check uniqueness — O(1) Map lookup
  const existing = stateStore.getUserByEmail(email);
  if (existing) {
    res.status(409).json({ error: 'Email already registered', code: 'CONFLICT' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  try {
    const user = await stateStore.createUser({ name, email, passwordHash, role });

    const accessToken = signAccessToken(user.id, user.email, user.role);
    const refreshToken = signRefreshToken(user.id);

    await stateStore.createRefreshToken({
      token: refreshToken,
      userId: user.id,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    });

    logger.info({ userId: user.id }, 'User signed up');
    res.status(201).json({
      accessToken,
      refreshToken,
      user: { id: user.id, name: user.name, email: user.email },
    });
  } catch (err: unknown) {
    const error = err as { status?: number; code?: string; message?: string };
    if (error.status === 409) {
      res.status(409).json({ error: 'Email already registered', code: 'CONFLICT' });
      return;
    }
    logger.error({ err }, 'Error creating user');
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// ── POST /auth/login ──────────────────────────────────
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input', code: 'INVALID_INPUT' });
    return;
  }

  const { email, password } = parsed.data;

  // O(1) lookup
  const user = stateStore.getUserByEmail(email);

  // Constant-time: always run bcrypt to prevent timing attacks
  const hashToCompare = user?.passwordHash ?? DUMMY_HASH;
  const passwordMatch = await bcrypt.compare(password, hashToCompare);

  if (!user || !passwordMatch) {
    res.status(401).json({ error: 'Invalid email or password', code: 'UNAUTHORIZED' });
    return;
  }

  try {
    const accessToken = signAccessToken(user.id, user.email, user.role);
    const refreshToken = signRefreshToken(user.id);

    await stateStore.createRefreshToken({
      token: refreshToken,
      userId: user.id,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    });

    logger.info({ userId: user.id }, 'User logged in');
    res.status(200).json({
      accessToken,
      refreshToken,
      user: { id: user.id, name: user.name, email: user.email },
    });
  } catch (err: unknown) {
    logger.error({ err }, 'Error during login');
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// ── POST /auth/refresh ────────────────────────────────
router.post('/refresh', async (req: Request, res: Response): Promise<void> => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Refresh token required', code: 'INVALID_INPUT' });
    return;
  }

  const { refreshToken } = parsed.data;

  let payload: { userId: string };
  try {
    payload = jwt.verify(refreshToken, JWT_REFRESH_SECRET) as { userId: string };
  } catch {
    res.status(401).json({ error: 'Invalid or expired token', code: 'UNAUTHORIZED' });
    return;
  }

  // O(1) lookup via secondary index
  const tokenRecord = stateStore.getRefreshTokenByToken(refreshToken);

  // SECURITY: Token reuse detection
  if (!tokenRecord || tokenRecord.used) {
    if (tokenRecord?.used) {
      await stateStore.invalidateUserRefreshTokens(payload.userId);
      logger.warn({ userId: payload.userId }, 'Refresh token reuse detected — session invalidated');
    }
    res.status(401).json({ error: 'Invalid or expired token', code: 'UNAUTHORIZED' });
    return;
  }

  if (new Date() > new Date(tokenRecord.expiresAt)) {
    res.status(401).json({ error: 'Invalid or expired token', code: 'UNAUTHORIZED' });
    return;
  }

  const user = stateStore.getUserById(tokenRecord.userId);
  if (!user) {
    res.status(401).json({ error: 'Invalid or expired token', code: 'UNAUTHORIZED' });
    return;
  }

  // Rotate: mark old token used
  await stateStore.markRefreshTokenUsed(tokenRecord.id);

  const accessToken = signAccessToken(user.id, user.email, user.role);

  logger.info({ userId: user.id }, 'Access token refreshed');
  res.status(200).json({ accessToken });
});

export default router;
