import { createHoldExpiryQueue, createHoldExpiryScheduler } from '@bmt/jobs';
import { createRazorpayGateway } from '@bmt/payments';
import {
  createLogger,
  createPool,
  createRedis,
  installProcessHandlers,
  loadEnvFile,
} from '@bmt/platform';
import { createApp } from './app';
import { authConfigFrom, bookingConfigFrom, loadConfig, razorpayConfigFrom } from './config';
import { createAuth } from './modules/auth/auth';
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
const auth = createAuth({ pool, redis, logger, config: authConfigFrom(config) });

const razorpay = razorpayConfigFrom(config);
if (!razorpay)
  logger.warn('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set: payment endpoints answer 503');

const holdExpiryQueue = createHoldExpiryQueue(config.REDIS_URL);
holdExpiryQueue.on('error', (err) => logger.error({ err }, 'hold expiry queue error'));

const app = createApp({
  logger,
  pool,
  redis,
  auth,
  booking: bookingConfigFrom(config),
  holdExpiry: createHoldExpiryScheduler(holdExpiryQueue, logger),
  paymentGateway: razorpay ? createRazorpayGateway(razorpay) : undefined,
  devPages: config.NODE_ENV === 'development',
});

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
    await Promise.all([pool.end(), redis.quit(), holdExpiryQueue.close()]);
  },
});
