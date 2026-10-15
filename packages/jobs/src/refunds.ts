import {
  DEFAULT_RECONCILE_OPTIONS,
  findPendingRefunds,
  reconcileOnce,
  sendRefund,
  type PaymentGateway,
  type ReconcileOptions,
  type RefundResult,
} from '@bmt/payments';
import type { Logger, Pool } from '@bmt/platform';
import { Queue, Worker } from 'bullmq';
import { QUEUE_PREFIX, queueConnection, type QueueOptions } from './connection';
import { startPeriodic, withTimeout, type Periodic } from './periodic';

/**
 * Refunds and the reconciler (ADR 0007). A refund is recorded in Postgres in
 * the transaction that decides a payment cannot be applied; this module gets
 * it to Razorpay:
 *
 * 1. A job per refund, queued right after that transaction commits (by the
 *    API for webhooks, by the reconciler for its own finds), retried with
 *    backoff while Razorpay is unreachable.
 * 2. A sweeper that re-queues refunds still PENDING after a while: a job that
 *    was lost, ran out of retries, or found Razorpay still processing. Money
 *    owed is retried until Razorpay settles it.
 *
 * Sending twice is harmless (our refund id is the Razorpay receipt), so the
 * job and the sweeper may overlap.
 */

export const REFUND_QUEUE = 'refunds';
const JOB_NAME = 'send';

export interface RefundJobData {
  refundId: string;
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

export interface RefundScheduler {
  /** Queues a refund that has just been recorded. Never throws; the sweeper is the fallback. */
  schedule(refundId: string): Promise<void>;
}

export function createRefundScheduler(
  queue: RefundQueue,
  logger: Logger,
  opts: { timeoutMs?: number } = {},
): RefundScheduler {
  const { timeoutMs = 1_000 } = opts;
  return {
    async schedule(refundId) {
      try {
        await withTimeout(queue.add(JOB_NAME, { refundId }, { jobId: refundId }), timeoutMs);
      } catch (err) {
        logger.warn({ err, refundId }, 'could not queue refund; the sweeper will send it');
      }
    },
  };
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

/** Runs the reconciler every `intervalMs` and queues the refunds it records. */
export function startReconciler(
  deps: { pool: Pool; gateway: PaymentGateway; refunds: RefundScheduler; logger: Logger },
  opts: { intervalMs: number } & Partial<ReconcileOptions>,
): Periodic {
  const options: ReconcileOptions = { ...DEFAULT_RECONCILE_OPTIONS, ...opts };
  return startPeriodic(
    'reconcile',
    async () => {
      const report = await reconcileOnce(deps.pool, deps.gateway, options);
      for (const outcome of report.outcomes) {
        if (outcome.kind === 'refund') await deps.refunds.schedule(outcome.refundId);
      }
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
