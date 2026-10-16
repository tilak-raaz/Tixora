import { Queue } from 'bullmq';
import { QUEUE_PREFIX, queueConnection, type QueueOptions } from './connection';

/**
 * The dead letter queue is BullMQ's failed set: jobs that used up their
 * attempts stay there (removeOnFail keeps them for days) instead of
 * disappearing. After the cause is fixed, replay moves them back to waiting
 * with their attempts reset. Replaying is always safe, because every consumer
 * deduplicates (refunds by Razorpay receipt, emails by processed_messages and
 * the provider's idempotency key, hold expiry by its conditional update).
 */

export const QUEUE_NAMES = ['email', 'refunds', 'hold-expiry'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export interface FailedJobSummary {
  id: string;
  name: string;
  attemptsMade: number;
  failedReason: string;
  failedAt: Date | null;
  requestId: string | null;
}

/** Minimal queue surface, so tests can pass any BullMQ queue. */
type FailedJobsQueue = Pick<Queue, 'getFailed'>;

export async function listFailed(queue: FailedJobsQueue, limit = 100): Promise<FailedJobSummary[]> {
  const jobs = await queue.getFailed(0, limit - 1);
  return jobs.map((job) => ({
    id: String(job.id),
    name: job.name,
    attemptsMade: job.attemptsMade,
    failedReason: job.failedReason,
    failedAt: job.finishedOn ? new Date(job.finishedOn) : null,
    requestId: (job.data as { requestId?: string | null }).requestId ?? null,
  }));
}

/** Moves up to `limit` failed jobs back to waiting. Returns the ids replayed. */
export async function replayFailed(queue: FailedJobsQueue, limit = 100): Promise<string[]> {
  const jobs = await queue.getFailed(0, limit - 1);
  const replayed: string[] = [];
  for (const job of jobs) {
    await job.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true });
    replayed.push(String(job.id));
  }
  return replayed;
}

/** A queue handle for the scripts: no default job options needed to read or replay. */
export function openQueue(name: QueueName, redisUrl: string, opts: QueueOptions = {}): Queue {
  return new Queue(name, {
    connection: queueConnection(redisUrl, opts),
    prefix: opts.prefix ?? QUEUE_PREFIX,
  });
}
