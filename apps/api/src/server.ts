import { createHoldExpiryQueue, createHoldExpiryScheduler } from '@bmt/jobs';
import { randomBytes } from 'node:crypto';
import { createFakeGateway, createRazorpayGateway } from '@bmt/payments';
import {
  createLogger,
  createPool,
  createRedis,
  createSeatEventPublisher,
  installProcessHandlers,
  loadEnvFile,
} from '@bmt/platform';
import { createApp } from './app';
import { createCache } from './lib/cache';
import { createApiMetrics } from './lib/metrics';
import { DEFAULT_RATE_LIMITS } from './lib/rate-limit';
import { authConfigFrom, bookingConfigFrom, loadConfig, razorpayConfigFrom } from './config';
import { createAuth } from './modules/auth/auth';
import { createSeatEventHub } from './modules/live/hub';
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

// Payments: Razorpay, or the fake for development (PAYMENT_GATEWAY=fake), or none (503).
const fakeGateway = config.PAYMENT_GATEWAY === 'fake' ? createFakeGateway() : undefined;
const razorpay = fakeGateway ? undefined : razorpayConfigFrom(config);
const paymentGateway = fakeGateway ?? (razorpay ? createRazorpayGateway(razorpay) : undefined);
// The fake signs its own webhooks; any secret works as long as it is the same one.
const paymentWebhookSecret =
  config.RAZORPAY_WEBHOOK_SECRET ?? (fakeGateway ? randomBytes(32).toString('hex') : undefined);
if (fakeGateway) logger.warn('PAYMENT_GATEWAY=fake: payments are simulated, nothing is charged');
else if (!razorpay)
  logger.warn('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set: payment endpoints answer 503');

// Live seat maps (ADR 0013): announce this replica's seat changes, forward everyone's.
const seatEvents = createSeatEventPublisher({ pool, redis, logger });
const seatEventHub = createSeatEventHub({ pool, redis, logger });

// Each replica's own numbers at GET /metrics (ADR 0015).
const metrics = createApiMetrics({ pool, seatStreams: () => seatEventHub.stats() });

const holdExpiryQueue = createHoldExpiryQueue(config.REDIS_URL);
holdExpiryQueue.on('error', (err) => logger.error({ err }, 'hold expiry queue error'));

const app = createApp({
  logger,
  pool,
  redis,
  auth,
  booking: bookingConfigFrom(config),
  holdExpiry: createHoldExpiryScheduler(holdExpiryQueue, logger),
  paymentGateway,
  paymentWebhookSecret,
  payment: { checkout: fakeGateway ? 'fake' : 'razorpay' },
  fakePayments: fakeGateway ? { gateway: fakeGateway } : undefined,
  rateLimits: config.RATE_LIMIT_ENABLED ? { policies: DEFAULT_RATE_LIMITS } : undefined,
  cache:
    config.CATALOG_CACHE_TTL_SECONDS > 0
      ? createCache(redis, logger, { ttlSeconds: config.CATALOG_CACHE_TTL_SECONDS })
      : undefined,
  seatEvents,
  seatEventHub,
  metrics,
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
    // 1. Stop accepting connections; in-flight requests carry on.
    const drained = new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    // 2. End the live seat streams: they never finish on their own, so the server would wait for
    //    them forever. Browsers reconnect by themselves, to another replica behind nginx.
    await seatEventHub.close();
    await drained;
    // 3. Only then close the connections those requests were using.
    await Promise.all([pool.end(), redis.quit(), holdExpiryQueue.close()]);
  },
});
