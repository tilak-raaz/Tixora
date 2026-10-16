import {
  createEmailQueue,
  createHoldExpiryWorker,
  createRefundQueue,
  createRefundWorker,
  startHoldSweeper,
  startOutboxRelay,
  startReconciler,
  startRefundSweeper,
  type Periodic,
} from '@bmt/jobs';
import { createRazorpayGateway } from '@bmt/payments';
import {
  createLogger,
  createPool,
  createRedis,
  installProcessHandlers,
  loadEnvFile,
} from '@bmt/platform';
import { ENV_FILE, loadConfig, razorpayConfigFrom } from './config';

/**
 * Worker process: runs everything slow or retryable, separately from the API.
 * Today: the outbox relay (ADR 0008), hold expiry (a delayed job per hold, plus
 * a sweeper as the safety net), refunds (a job per refund, plus a sweeper) and
 * the payment reconciler. M4 PR 2 adds the email consumer.
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
const queues = ['hold-expiry'];
const periodic: Periodic[] = [sweeper];
const closers: (() => Promise<void>)[] = [() => holdExpiry.close()];

// The relay always runs: committed events are queued even while their
// consumers are missing (no Razorpay keys, or the email consumer before PR 2).
const emailQueue = createEmailQueue(config.REDIS_URL);
const refundQueue = createRefundQueue(config.REDIS_URL);
for (const q of [emailQueue, refundQueue]) {
  q.on('error', (err) => logger.error({ err, queue: q.name }, 'queue error'));
}
periodic.push(
  startOutboxRelay(
    { pool, queues: { email: emailQueue, refunds: refundQueue }, logger },
    { intervalMs: config.OUTBOX_RELAY_INTERVAL_MS },
  ),
);

const razorpay = razorpayConfigFrom(config);
if (razorpay) {
  const gateway = createRazorpayGateway(razorpay);
  const refundWorker = createRefundWorker({ redisUrl: config.REDIS_URL, pool, gateway, logger });
  periodic.push(
    startRefundSweeper(
      { pool, queue: refundQueue, logger },
      { intervalMs: config.REFUND_SWEEP_INTERVAL_MS },
    ),
    startReconciler({ pool, gateway, logger }, { intervalMs: config.RECONCILE_INTERVAL_MS }),
  );
  closers.push(() => refundWorker.close());
  queues.push('refunds');
} else {
  logger.warn('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set: no refunds, no reconciler');
}
closers.push(
  () => emailQueue.close(),
  () => refundQueue.close(),
);

stopConsumers = async () => {
  // Stop polling first, then let in-flight jobs finish, then drop the queues.
  await Promise.all(periodic.map((p) => p.stop()));
  for (const close of closers) await close();
};

logger.info({ queues, relay: true }, 'worker ready');
