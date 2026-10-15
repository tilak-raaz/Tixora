import { createHoldExpiryWorker, startHoldSweeper } from '@bmt/jobs';
import {
  createLogger,
  createPool,
  createRedis,
  installProcessHandlers,
  loadEnvFile,
} from '@bmt/platform';
import { ENV_FILE, loadConfig } from './config';

/**
 * Worker process: runs everything slow or retryable, separately from the API.
 * Today: hold expiry (a delayed job per hold, plus a sweeper as the safety net).
 * M3 adds the payment reconciler; M4 the outbox relay, email and tickets.
 */
loadEnvFile(ENV_FILE);
const config = loadConfig();

const logger = createLogger({
  name: 'worker',
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === 'development',
});

const pool = createPool({
  connectionString: config.DATABASE_URL,
  max: config.DATABASE_POOL_MAX,
  applicationName: 'bmt-worker',
  logger,
});
const redis = createRedis(config.REDIS_URL, logger);

let stopConsumers = async (): Promise<void> => undefined;

installProcessHandlers({
  logger,
  timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
  close: async () => {
    // Stop taking jobs and let in-flight ones finish, then close connections.
    await stopConsumers();
    await Promise.all([pool.end(), redis.quit()]);
  },
});

try {
  await Promise.all([pool.query('SELECT 1'), redis.ping()]);
} catch (err) {
  logger.fatal({ err }, 'worker could not reach its dependencies');
  process.exit(1);
}

const holdExpiry = createHoldExpiryWorker(
  { redisUrl: config.REDIS_URL, pool, logger },
  { concurrency: config.HOLD_EXPIRY_CONCURRENCY },
);
const sweeper = startHoldSweeper(
  { pool, logger },
  { intervalMs: config.HOLD_SWEEP_INTERVAL_MS, batchSize: config.HOLD_SWEEP_BATCH_SIZE },
);
stopConsumers = async () => {
  await sweeper.stop();
  await holdExpiry.close();
};

logger.info(
  { queues: ['hold-expiry'], sweepIntervalMs: config.HOLD_SWEEP_INTERVAL_MS },
  'worker ready',
);
