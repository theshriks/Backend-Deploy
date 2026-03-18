// ── ShrikDB — Event Store + WebSocket Broadcaster ────────────────────────────
//
// ARCHITECTURE (Post-Migration):
//   1. WebSocket server: broadcasts events to React clients per jobId
//   2. emitEvent(): sends events to ShrikDB service for WAL logging (when connected)
//   3. handleShrikDBEvent(): processes inbound events from ShrikDB → updates StateStore → broadcasts
//
// The StateStore (state-store.ts) is the source of truth for all reads.
// ShrikDB is the persistence layer — all writes go through the ShrikDB client.
//
// CLOUDFLARE PRODUCTION: WebSockets are BLOCKED by default
// CF Dashboard → theshriks.space → Network → WebSockets → ON
// Always use wss:// in production, never ws://

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { stateStore } from './state-store';
import { logger } from './logger';

// ── Event Types ──────────────────────────────────────────────────────────────

export type ShrikDBEventType =
  | 'training.step'
  | 'training.completed'
  | 'training.failed'
  | 'eval.result'
  | 'eval.completed'
  | 'safety.violation'
  | 'redteam.completed'
  | 'deploy.live'
  | 'model.version.created'
  | 'compliance.generated';

export interface ShrikDBEvent {
  event_type: ShrikDBEventType;
  timestamp: string;
  [key: string]: unknown;
}

// ── SHRIKDB_URL Check ────────────────────────────────────────────────────────

const SHRIKDB_URL = process.env['SHRIKDB_URL'] ?? '';

if (!SHRIKDB_URL) {
  logger.warn('SHRIKDB_URL is not set — emitEvent() will only broadcast locally via WebSocket. WAL logging disabled.');
}

// ── WebSocket State ──────────────────────────────────────────────────────────

const jobClients = new Map<string, Set<WebSocket>>();

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;

// ── WebSocket Server Init ────────────────────────────────────────────────────

export function initShrikDBWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '', `http://${req.headers.host}`);
    const jobId = url.searchParams.get('jobId');

    if (!jobId) {
      ws.close(4000, 'jobId query parameter required');
      return;
    }

    if (!jobClients.has(jobId)) {
      jobClients.set(jobId, new Set());
    }
    jobClients.get(jobId)!.add(ws);
    logger.info({ jobId }, 'WS client connected');

    let pongTimer: ReturnType<typeof setTimeout> | null = null;

    const pingInterval = setInterval(() => {
      pongTimer = setTimeout(() => {
        logger.warn({ jobId }, 'WS client pong timeout — terminating');
        ws.terminate();
      }, PONG_TIMEOUT_MS);

      ws.ping();
    }, PING_INTERVAL_MS);

    ws.on('pong', () => {
      if (pongTimer) {
        clearTimeout(pongTimer);
        pongTimer = null;
      }
    });

    ws.on('close', () => {
      const clients = jobClients.get(jobId);
      if (clients) {
        clients.delete(ws);
        if (clients.size === 0) {
          jobClients.delete(jobId);
        }
      }
      clearInterval(pingInterval);
      if (pongTimer) clearTimeout(pongTimer);
      logger.info({ jobId }, 'WS client disconnected');
    });

    ws.on('error', (err) => {
      logger.error({ err, jobId }, 'WS client error');
    });
  });

  logger.info('ShrikDB WebSocket server initialized at /ws');
  return wss;
}

// ── Broadcast to React clients ───────────────────────────────────────────────

export function broadcastToJob(jobId: string, event: Record<string, unknown>): void {
  const clients = jobClients.get(jobId);
  if (!clients || clients.size === 0) return;

  const payload = JSON.stringify(event);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

export function getConnectedClientCount(jobId: string): number {
  return jobClients.get(jobId)?.size ?? 0;
}

// ── Emit Event (to ShrikDB WAL + local broadcast) ────────────────────────────

export async function emitEvent(
  eventType: ShrikDBEventType,
  payload: Record<string, unknown>,
): Promise<void> {
  const event: ShrikDBEvent = {
    event_type: eventType,
    timestamp: new Date().toISOString(),
    ...payload,
  };

  const jobId = typeof payload['jobId'] === 'string' ? payload['jobId'] : null;
  if (jobId) {
    broadcastToJob(jobId, event);
  }

  if (SHRIKDB_URL) {
    try {
      const response = await fetch(`${SHRIKDB_URL}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) {
        logger.warn(
          { eventType, status: response.status },
          'ShrikDB WAL rejected event — continuing without WAL',
        );
      }
    } catch (err: unknown) {
      logger.warn(
        { err, eventType },
        'ShrikDB WAL unreachable — event broadcast locally only',
      );
    }
  }
}

// ── Handle Inbound ShrikDB Events ────────────────────────────────────────────
// Updates in-memory StateStore and broadcasts to WebSocket clients.
// Terminal state guards prevent processing stale events.

export async function handleShrikDBEvent(event: ShrikDBEvent): Promise<void> {
  const eventType = event.event_type;

  switch (eventType) {
    case 'training.step': {
      const jobId = event['jobId'] as string | undefined;
      if (!jobId) { logger.warn({ event }, 'training.step missing jobId — skipping'); return; }

      const job = stateStore.getJobById(jobId);
      if (!job) {
        logger.warn({ jobId }, 'training.step: job not found — broadcasting only');
        broadcastToJob(jobId, event);
        return;
      }

      if (job.status === 'COMPLETED' || job.status === 'FAILED') {
        logger.warn({ jobId, currentStatus: job.status }, 'training.step arrived for terminal job — ignoring');
        return;
      }

      await stateStore.updateJobStatus(jobId, { status: 'RUNNING' });

      const progress = typeof event['step'] === 'number' && typeof event['totalSteps'] === 'number' && (event['totalSteps'] as number) > 0
        ? Math.round(((event['step'] as number) / (event['totalSteps'] as number)) * 100)
        : undefined;

      await stateStore.updateJobProgress(jobId, {
        progress: progress ?? 0,
        currentLoss: typeof event['loss'] === 'number' ? event['loss'] as number : undefined,
        currentStep: typeof event['step'] === 'number' ? event['step'] as number : undefined,
        totalSteps: typeof event['totalSteps'] === 'number' ? event['totalSteps'] as number : undefined,
      });

      broadcastToJob(jobId, event);
      break;
    }

    case 'training.completed': {
      const jobId = event['jobId'] as string | undefined;
      if (!jobId) { logger.warn({ event }, 'training.completed missing jobId — skipping'); return; }

      const job = stateStore.getJobById(jobId);
      if (!job) {
        logger.warn({ jobId }, 'training.completed: job not found — broadcasting only');
        broadcastToJob(jobId, event);
        return;
      }

      if (job.status === 'COMPLETED' || job.status === 'FAILED') {
        logger.warn({ jobId, currentStatus: job.status }, 'training.completed arrived for terminal job — ignoring');
        return;
      }

      let checkpointPath = event['checkpointPath'] as string | null | undefined;
      if (!checkpointPath) {
        logger.warn({ jobId }, 'training.completed: checkpointPath is null — using fallback');
        checkpointPath = `checkpoints/${jobId}`;
      }

      await stateStore.updateJobStatus(jobId, {
        status: 'COMPLETED',
        checkpointPath,
        completedAt: new Date().toISOString(),
      });
      await stateStore.updateJobProgress(jobId, { progress: 100 });

      broadcastToJob(jobId, event);
      break;
    }

    case 'training.failed': {
      const jobId = event['jobId'] as string | undefined;
      if (!jobId) { logger.warn({ event }, 'training.failed missing jobId — skipping'); return; }

      const job = stateStore.getJobById(jobId);
      if (!job) {
        logger.warn({ jobId }, 'training.failed: job not found — broadcasting only');
        broadcastToJob(jobId, event);
        return;
      }

      if (job.status === 'COMPLETED' || job.status === 'FAILED') {
        logger.warn({ jobId, currentStatus: job.status }, 'training.failed arrived for terminal job — ignoring');
        return;
      }

      const errorMessage = typeof event['error'] === 'string' ? event['error'] as string : 'Unknown error';
      await stateStore.updateJobStatus(jobId, {
        status: 'FAILED',
        errorMessage,
        completedAt: new Date().toISOString(),
      });

      broadcastToJob(jobId, event);
      break;
    }

    case 'eval.completed': {
      const modelId = event['modelId'] as string | undefined;
      if (!modelId) { logger.warn({ event }, 'eval.completed missing modelId — skipping'); return; }

      const model = stateStore.getModelById(modelId);
      if (!model) {
        logger.warn({ modelId }, 'eval.completed: model not found — skipping');
        return;
      }

      const benchmarks = event['allBenchmarks'] as Record<string, number> | undefined;
      if (benchmarks) {
        await stateStore.updateModelStatus(modelId, {
          status: 'EVALUATED',
          benchmarks,
        });
      }

      const jobId = event['jobId'] as string | undefined;
      if (jobId) broadcastToJob(jobId, event);
      break;
    }

    case 'deploy.live': {
      const modelId = event['modelId'] as string | undefined;
      if (!modelId) { logger.warn({ event }, 'deploy.live missing modelId — skipping'); return; }

      const model = stateStore.getModelById(modelId);
      if (!model) {
        logger.warn({ modelId }, 'deploy.live: model not found — skipping');
        return;
      }

      await stateStore.updateModelStatus(modelId, {
        status: 'DEPLOYED',
        deployedAt: new Date().toISOString(),
      });

      const jobId = event['jobId'] as string | undefined;
      if (jobId) broadcastToJob(jobId, event);
      break;
    }

    // All other event types: log only
    case 'eval.result':
    case 'safety.violation':
    case 'redteam.completed':
    case 'model.version.created':
    case 'compliance.generated': {
      logger.info({ eventType }, 'ShrikDB event received (log-only)');
      const jobId = event['jobId'] as string | undefined;
      if (jobId) broadcastToJob(jobId, event);
      break;
    }

    default: {
      logger.warn({ eventType }, 'Unknown ShrikDB event type — ignoring');
    }
  }
}

// ── Test Helper ──────────────────────────────────────────────────────────────
export async function testEventEmit(): Promise<void> {
  const testEvent: Record<string, unknown> = {
    jobId: 'test-job-1',
    projectId: 'test-project-1',
    step: 42, totalSteps: 1000,
    loss: 0.342, lr: 0.0001, gpuUtil: 87.5,
  };

  logger.info({ payload: testEvent }, '[shrikdb] Test event emitted: training.step');

  try {
    await emitEvent('training.step', testEvent);
    logger.info(
      { shrikdbUrl: SHRIKDB_URL || '(not configured — local broadcast only)' },
      '[shrikdb] ShrikDB connection: OK',
    );
  } catch (err: unknown) {
    logger.error({ err }, '[shrikdb] ShrikDB connection: FAILED');
  }
}
