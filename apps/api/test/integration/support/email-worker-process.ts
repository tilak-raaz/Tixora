import { createEmailWorker } from '@bmt/jobs';
import { createLogger, createPool, createRedis } from '@bmt/platform';
import { createRedisMailer } from './redis-mailer';

/**
 * An email worker in its own process, for the failure drill to SIGKILL.
 * Configured entirely by environment variables set by the test.
 */
const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const logger = createLogger({ name: 'drill-worker', level: 'silent' });
const pool = createPool({
  connectionString: env('DATABASE_URL'),
  max: 4,
  applicationName: 'bmt-drill-worker',
  logger,
});
const redis = createRedis(env('REDIS_URL'), logger);
const worker = createEmailWorker(
  {
    redisUrl: env('REDIS_URL'),
    pool,
    mailer: createRedisMailer(redis, env('MAIL_NS'), Number(env('MAIL_DELAY_MS'))),
    logger,
  },
  { prefix: env('QUEUE_PREFIX'), concurrency: 4, lockDuration: 1_500, stalledInterval: 500 },
);
await worker.waitUntilReady();
process.stdout.write('ready\n');
