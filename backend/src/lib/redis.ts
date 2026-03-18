import { Redis } from 'ioredis';
import logger from './logger';

const REDIS_URL = process.env.REDIS_URL;

let redisConnection: Redis | null = null;

if (REDIS_URL) {
  redisConnection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

  redisConnection.on('error', (err) => {
    logger.error({ err }, 'Redis connection error');
  });

  redisConnection.on('connect', () => {
    logger.info('Redis connected');
  });
} else {
  logger.warn('REDIS_URL not set — BullMQ and caching will not work');
}

export default redisConnection;
