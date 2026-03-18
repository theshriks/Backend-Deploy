import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import logger from './logger';

const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '';

if (!connectionString) {
  logger.error('DATABASE_URL / DIRECT_URL not set — Prisma will fail');
}

const adapter = new PrismaPg({ connectionString });

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ adapter });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// NOTE: Prisma 7 with driver adapters does NOT support $on('error'/'query'/etc).
// All DB errors are caught inline via .catch() in route handlers.

export default prisma;
