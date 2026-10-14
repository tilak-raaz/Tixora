import {
  createLogger,
  createPool,
  createRedis,
  installProcessHandlers,
  loadEnvFile,
} from '@bmt/platform';
import { createApp } from './app';
import { loadConfig } from './config';
import { ENV_FILE } from './paths';

loadEnvFile(ENV_FILE);
const config = loadConfig();

const logger = createLogger({
  name: 'api',
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === 'development',
});

const pool = createPool({
  connectionString: config.DATABASE_URL,
  max: config.DATABASE_POOL_MAX,
  applicationName: 'bmt-api',
  logger,
});
const redis = createRedis(config.REDIS_URL, logger);

const app = createApp({ logger, pool, redis });

const server = app.listen(config.PORT, (err?: Error) => {
  if (err) {
    logger.fatal({ err }, 'failed to start http server');
    process.exit(1);
  }
  logger.info({ port: config.PORT }, 'api listening');
});

installProcessHandlers({
  logger,
  timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
  close: async () => {
    // 1. Stop accepting connections and wait for in-flight requests to finish.
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    // 2. Only then close the connections those requests were using.
    await Promise.all([pool.end(), redis.quit()]);
  },
});
