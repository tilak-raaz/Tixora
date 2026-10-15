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
 * In M0 it only proves it can start, reach Postgres and Redis, and shut down
 * cleanly. Queue consumers arrive in M2 (hold expiry) and M4 (outbox relay,
 * email, tickets); the payment reconciler arrives in M3.
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

installProcessHandlers({
  logger,
  timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
  close: async () => {
    // From M4: stop consumers first so in-flight jobs finish, then close connections.
    await Promise.all([pool.end(), redis.quit()]);
  },
});

try {
  await Promise.all([pool.query('SELECT 1'), redis.ping()]);
  logger.info('worker ready (no queues registered yet)');
} catch (err) {
  logger.fatal({ err }, 'worker could not reach its dependencies');
  process.exit(1);
}
