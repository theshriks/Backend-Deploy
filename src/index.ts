import 'dotenv/config';
import http from 'http';
import app from './app';
import logger from './lib/logger';
import prisma from './lib/prisma';
import redisConnection from './lib/redis';
import { ensureBuckets } from './lib/minio';
import { trainingQueue } from './lib/queue';
import { initShrikDBWebSocket, testEventEmit } from './lib/shrikdb';
import { startTrainingWorker } from './workers/training.worker';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

const server = http.createServer(app);

// ── WebSocket ─────────────────────────────────────────
initShrikDBWebSocket(server);

// ── BullMQ Worker ─────────────────────────────────────
const worker = startTrainingWorker();

// ── Start server ──────────────────────────────────────
async function main(): Promise<void> {
  // Ensure MinIO buckets exist before accepting traffic
  await ensureBuckets();

  server.listen(PORT, () => {
    logger.info({ port: PORT, env: process.env.NODE_ENV ?? 'development' }, 'ModelForge backend running');

    // Run ShrikDB test emit in dev mode only
    if (process.env.NODE_ENV !== 'production') {
      testEventEmit().catch(() => null);
    }
  });
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});

// ── Graceful shutdown ─────────────────────────────────
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Received shutdown signal — starting graceful shutdown');

  // 1. Stop accepting new connections
  server.close(() => logger.info('HTTP server closed'));

  // 2. Close BullMQ worker (finish current jobs)
  if (worker) {
    await worker.close().catch((err: unknown) => logger.error({ err }, 'Error closing BullMQ worker'));
    logger.info('BullMQ worker closed');
  }

  // 3. Close BullMQ queue (flush pending operations)
  if (trainingQueue) {
    await trainingQueue.close().catch((err: unknown) => logger.error({ err }, 'Error closing BullMQ queue'));
    logger.info('BullMQ queue closed');
  }

  // 4. Disconnect Redis
  if (redisConnection) {
    await redisConnection.quit().catch((err: unknown) => logger.error({ err }, 'Error closing Redis'));
    logger.info('Redis disconnected');
  }

  // 4. Disconnect Prisma
  await prisma.$disconnect().catch((err: unknown) => logger.error({ err }, 'Error closing Prisma'));
  logger.info('Prisma disconnected');

  process.exit(0);
}

// Force exit if graceful shutdown takes too long
function forceExit(signal: string): void {
  void shutdown(signal);
  setTimeout(() => {
    logger.error('Forced shutdown after 15s timeout');
    process.exit(1);
  }, 15_000);
}

process.on('SIGTERM', () => forceExit('SIGTERM'));
process.on('SIGINT', () => forceExit('SIGINT'));
