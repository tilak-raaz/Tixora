import { Redis } from 'ioredis';
import type { Logger } from 'pino';

export type { Redis };

export function createRedis(url: string, logger: Logger): Redis {
  const redis = new Redis(url, {
    // Fail a command after 3 reconnect attempts instead of queueing it forever.
    // BullMQ needs other settings, so it opens its own connections (@bmt/jobs).
    maxRetriesPerRequest: 3,
  });
  redis.on('error', (err) => logger.error({ err }, 'redis error'));
  return redis;
}
