import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { defaultLimiter } from './middleware/rateLimiter';
import { errorHandler } from './middleware/errorHandler';
import { logger } from './lib/logger';

import authRoutes from './routes/auth';
import projectRoutes from './routes/projects';
import datasetRoutes from './routes/datasets';
import jobRoutes from './routes/jobs';
import modelRoutes from './routes/models';
import evalRoutes from './routes/eval';
import complianceRoutes from './routes/compliance';
import inferRoutes from './routes/infer';
import guardrailsRoutes from './routes/guardrails';

const app = express();

// ── Security ──────────────────────────────────────────
app.use(helmet());

const CORS_ORIGINS = process.env['NODE_ENV'] === 'production'
  ? ['https://theshriks.space', 'https://www.theshriks.space']
  : true;

app.use(cors({
  origin: CORS_ORIGINS,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(defaultLimiter);

// ── Body parsing ──────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Request logging ───────────────────────────────────
app.use((req, _res, next) => {
  logger.info({ method: req.method, path: req.path }, 'Incoming request');
  next();
});

// ── Health check ──────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Routes ────────────────────────────────────────────
app.use('/auth', authRoutes);
app.use('/projects', projectRoutes);
app.use('/datasets', datasetRoutes);
app.use('/jobs', jobRoutes);
app.use('/models', modelRoutes);
app.use('/eval', evalRoutes);
app.use('/compliance', complianceRoutes);
app.use('/infer', inferRoutes);
app.use('/guardrails', guardrailsRoutes);

// ── 404 handler ───────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found', code: 'NOT_FOUND' });
});

// ── Global error handler (MUST be last) ───────────────
app.use(errorHandler);

export default app;
