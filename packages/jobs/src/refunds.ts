import {
  DEFAULT_RECONCILE_OPTIONS,
  findPendingRefunds,
  reconcileOnce,
  sendRefund,
  type PaymentGateway,
  type ReconcileOptions,
  type RefundResult,
} from '@bmt/payments';
import type { Logger, Pool, SeatEventPublisher } from '@bmt/platform';
import { Queue, Worker } from 'bullmq';
import { QUEUE_PREFIX, queueConnection, type QueueOptions } from './connection';
import { startPeriodic, type Periodic } from './periodic';

/**
 * Refunds and the reconciler (ADR 0007, ADR 0008). A refund is recorded in
 * Postgres, with a refund.recorded outbox event, in the transaction that
 * decides a payment cannot be applied. The relay turns that event into a job
 * here, which gets the refund to Razorpay, retried with backoff while Razorpay
 * is unreachable. A sweeper re-queues refunds still PENDING after a while: a
 * job whose retries ran out, or one that found Razorpay still processing.
 * Money owed is retried until Razorpay settles it.
 *
 * Sending twice is harmless (our refund id is the Razorpay receipt), so the
 * job and the sweeper may overlap.
 */

export const REFUND_QUEUE = 'refunds';
const JOB_NAME = 'send';

/** From the relay: the refund.recorded payload plus the outbox id; from the sweeper: refundId alone. */
export interface RefundJobData {
  refundId: string;
  outboxId?: string;
  requestId?: string | null;
}

export type RefundQueue = Queue<RefundJobData, RefundResult, typeof JOB_NAME>;

export function createRefundQueue(redisUrl: string, opts: QueueOptions = {}): RefundQueue {
  return new Queue<RefundJobData, RefundResult, typeof JOB_NAME>(REFUND_QUEUE, {
    connection: queueConnection(redisUrl, opts),
    prefix: opts.prefix ?? QUEUE_PREFIX,
    defaultJobOptions: {
      attempts: 8,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 60 * 60 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    },
  });
}

export type RefundWorker = Worker<RefundJobData, RefundResult, typeof JOB_NAME>;

export function createRefundWorker(
  deps: { redisUrl: string; pool: Pool; gateway: PaymentGateway; logger: Logger },
  opts: QueueOptions & { concurrency?: number } = {},
): RefundWorker {
  const { logger } = deps;
  const worker = new Worker<RefundJobData, RefundResult, typeof JOB_NAME>(
    REFUND_QUEUE,
    async (job) => sendRefund(deps.pool, deps.gateway, job.data.refundId),
    {
      connection: queueConnection(deps.redisUrl, opts),
      prefix: opts.prefix ?? QUEUE_PREFIX,
      concurrency: opts.concurrency ?? 5,
    },
  );
  worker.on('completed', (job, result) => {
    const log = { refundId: job.data.refundId, result };
    if (result === 'failed')
      logger.error(log, 'Razorpay could not refund; a person must follow up');
    else logger.info(log, 'refund job done');
  });
  worker.on('failed', (job, err) => {
    logger.warn(
      { err, refundId: job?.data.refundId, attempt: job?.attemptsMade },
      'refund job failed; it will be retried',
    );
  });
  worker.on('error', (err) => logger.error({ err }, 'refund worker error'));
  return worker;
}

/** Re-queues refunds still PENDING after `olderThanSeconds`; see the module comment. */
export function startRefundSweeper(
  deps: { pool: Pool; queue: RefundQueue; logger: Logger },
  opts: { intervalMs: number; olderThanSeconds?: number; batchSize?: number },
): Periodic {
  return startPeriodic(
    'refund sweep',
    async () => {
      const ids = await findPendingRefunds(deps.pool, {
        olderThanSeconds: opts.olderThanSeconds ?? 60,
        limit: opts.batchSize ?? 200,
      });
      // One job id per refund per interval, so workers sweeping at the same time queue it once.
      const round = Math.floor(Date.now() / opts.intervalMs);
      for (const refundId of ids) {
        await deps.queue.add(JOB_NAME, { refundId }, { jobId: `${refundId}-sweep-${round}` });
      }
      if (ids.length > 0)
        deps.logger.info({ requeued: ids.length }, 'refund sweeper re-queued refunds');
    },
    { intervalMs: opts.intervalMs, logger: deps.logger },
  );
}

/**
 * Runs the reconciler every `intervalMs`. Refunds it records reach Razorpay
 * through the outbox, like every other refund.
 */
export function startReconciler(
  deps: {
    pool: Pool;
    gateway: PaymentGateway;
    logger: Logger;
    /** Announces seats of bookings it confirms (ADR 0013). */
    seatEvents?: SeatEventPublisher;
  },
  opts: { intervalMs: number } & Partial<ReconcileOptions>,
): Periodic {
  const options: ReconcileOptions = { ...DEFAULT_RECONCILE_OPTIONS, ...opts };
  return startPeriodic(
    'reconcile',
    async () => {
      const report = await reconcileOnce(deps.pool, deps.gateway, options);
      const confirmed = report.outcomes.flatMap((o) =>
        o.kind === 'confirmed' ? [o.bookingId] : [],
      );
      await deps.seatEvents?.publishBookings(confirmed);
      if (report.outcomes.length > 0 || report.failed > 0) {
        deps.logger.warn(
          {
            checked: report.checked,
            failed: report.failed,
            applied: report.outcomes.map((o) => o.kind),
          },
          'reconciler applied payments the webhook never delivered',
        );
      }
    },
    { intervalMs: opts.intervalMs, logger: deps.logger },
  );
}
