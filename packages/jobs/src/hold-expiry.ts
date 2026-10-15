import type { Logger, Pool, PoolClient } from '@bmt/platform';
import { Queue, Worker } from 'bullmq';
import { QUEUE_PREFIX, queueConnection, type QueueOptions } from './connection';

/**
 * Hold expiry (ADR 0006). A hold's seats are already free for other buyers the
 * moment it runs out (the hold query treats an expired hold as free), so
 * nothing here protects against double booking. This keeps the data true: the
 * booking becomes EXPIRED and its seats AVAILABLE, close to the moment it
 * happens.
 *
 * Two paths do the same conditional update, so running either one late, twice,
 * or at the same time as the other is harmless:
 *
 * 1. A delayed job per hold, added by the API right after the hold commits.
 * 2. A sweeper in every worker that catches any hold whose job was lost
 *    (Redis lost data, the API died between commit and enqueue, workers down).
 */

type Db = Pool | PoolClient;

export const HOLD_EXPIRY_QUEUE = 'hold-expiry';
const JOB_NAME = 'expire';

export interface HoldExpiryData {
  bookingId: string;
}

/** `skipped`: the booking was paid, cancelled, already expired, or not due yet. */
export type HoldExpiryResult = 'expired' | 'skipped';

// ---------------------------------------------------------------------------
// The database side: Postgres decides, whichever path gets there first.
// ---------------------------------------------------------------------------

/**
 * Seats go back only while this booking still holds them. A seat that another
 * buyer has taken since the hold ran out now points at their booking, so the
 * `booking_id` condition leaves it alone (Postgres re-checks it after any lock
 * wait).
 */
const FREE_SEATS = `
  UPDATE show_seats
  SET status = 'AVAILABLE', booking_id = NULL, held_until = NULL, version = version + 1
  WHERE booking_id IN (SELECT id FROM expired) AND status = 'HELD'`;

/** Expires one booking if it is still a pending hold whose time is up. */
export async function expireHold(db: Db, bookingId: string): Promise<HoldExpiryResult> {
  const { rows } = await db.query<{ id: string }>(
    `WITH expired AS (
       UPDATE bookings SET status = 'EXPIRED'
       WHERE id = $1 AND status = 'PENDING_PAYMENT' AND expires_at <= now()
       RETURNING id
     ), freed AS (${FREE_SEATS})
     SELECT id FROM expired`,
    [bookingId],
  );
  return rows.length === 1 ? 'expired' : 'skipped';
}

/**
 * Expires up to `batchSize` overdue holds, oldest first, and returns their ids.
 * SKIP LOCKED lets several sweepers (one per worker) run at once: each takes
 * rows nobody else has locked, so no hold is released twice and no sweeper
 * waits for another.
 */
export async function sweepExpiredHolds(db: Db, batchSize: number): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `WITH due AS (
       SELECT id FROM bookings
       WHERE status = 'PENDING_PAYMENT' AND expires_at <= now()
       ORDER BY expires_at
       LIMIT $1
       FOR NO KEY UPDATE SKIP LOCKED
     ), expired AS (
       UPDATE bookings b SET status = 'EXPIRED' FROM due WHERE b.id = due.id RETURNING b.id
     ), freed AS (${FREE_SEATS})
     SELECT id FROM expired`,
    [batchSize],
  );
  return rows.map((r) => r.id);
}

/** Sweeps batch after batch until a batch comes back short. */
export async function drainExpiredHolds(db: Db, batchSize: number): Promise<string[]> {
  const all: string[] = [];
  for (;;) {
    const batch = await sweepExpiredHolds(db, batchSize);
    all.push(...batch);
    if (batch.length < batchSize) return all;
  }
}

// ---------------------------------------------------------------------------
// Producer side (API)
// ---------------------------------------------------------------------------

export type HoldExpiryQueue = Queue<HoldExpiryData, HoldExpiryResult, typeof JOB_NAME>;

export function createHoldExpiryQueue(redisUrl: string, opts: QueueOptions = {}): HoldExpiryQueue {
  return new Queue<HoldExpiryData, HoldExpiryResult, typeof JOB_NAME>(HOLD_EXPIRY_QUEUE, {
    connection: queueConnection(redisUrl, opts),
    prefix: opts.prefix ?? QUEUE_PREFIX,
    defaultJobOptions: {
      // Retries are for Postgres being briefly unreachable; the update itself is safe to repeat.
      attempts: 5,
      backoff: { type: 'exponential', delay: 1_000 },
      // Kept for an hour so a job can be inspected, and so the same booking id cannot be queued twice.
      removeOnComplete: { age: 60 * 60 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    },
  });
}

export interface HoldExpiryScheduler {
  /**
   * Queues the expiry of a hold that has just been committed. Never throws and
   * never waits long: the hold already exists, so a Redis problem must not turn
   * a successful hold into an error. A hold that misses its job is released by
   * the sweeper instead.
   */
  schedule(bookingId: string, expiresAt: Date): Promise<void>;
}

export function createHoldExpiryScheduler(
  queue: HoldExpiryQueue,
  logger: Logger,
  opts: {
    /** Longest the API waits for Redis before giving up on the job. */
    timeoutMs?: number;
    /** Run a little after expiry, so a Node clock ahead of Postgres does not find the hold "not due yet". */
    graceMs?: number;
  } = {},
): HoldExpiryScheduler {
  const { timeoutMs = 1_000, graceMs = 1_000 } = opts;
  return {
    async schedule(bookingId, expiresAt) {
      const delay = Math.max(0, expiresAt.getTime() - Date.now()) + graceMs;
      try {
        // The booking id is the job id, so a second schedule for the same hold adds nothing.
        await withTimeout(
          queue.add(JOB_NAME, { bookingId }, { jobId: bookingId, delay }),
          timeoutMs,
        );
      } catch (err) {
        logger.warn({ err, bookingId }, 'could not queue hold expiry; the sweeper will release it');
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Consumer side (worker)
// ---------------------------------------------------------------------------

export type HoldExpiryWorker = Worker<HoldExpiryData, HoldExpiryResult, typeof JOB_NAME>;

export function createHoldExpiryWorker(
  deps: { redisUrl: string; pool: Pool; logger: Logger },
  opts: QueueOptions & { concurrency?: number } = {},
): HoldExpiryWorker {
  const { logger } = deps;
  const worker = new Worker<HoldExpiryData, HoldExpiryResult, typeof JOB_NAME>(
    HOLD_EXPIRY_QUEUE,
    async (job) => expireHold(deps.pool, job.data.bookingId),
    {
      connection: queueConnection(deps.redisUrl, opts),
      prefix: opts.prefix ?? QUEUE_PREFIX,
      concurrency: opts.concurrency ?? 10,
    },
  );
  worker.on('completed', (job, result) => {
    logger.debug({ bookingId: job.data.bookingId, result }, 'hold expiry job done');
  });
  worker.on('failed', (job, err) => {
    logger.warn(
      { err, bookingId: job?.data.bookingId, attempt: job?.attemptsMade },
      'hold expiry job failed',
    );
  });
  worker.on('error', (err) => logger.error({ err }, 'hold expiry worker error'));
  return worker;
}

export interface HoldSweeper {
  /** Stops scheduling sweeps and waits for one in progress to finish. */
  stop(): Promise<void>;
}

/**
 * Sweeps once at start-up (catching holds that ran out while workers were
 * down), then every `intervalMs`, with jitter so workers do not sweep in step.
 * It depends only on Postgres, so it still works when the thing it backs up,
 * the Redis queue, does not.
 */
export function startHoldSweeper(
  deps: { pool: Pool; logger: Logger },
  opts: { intervalMs: number; batchSize: number },
): HoldSweeper {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  const sweep = async (): Promise<void> => {
    try {
      const released = await drainExpiredHolds(deps.pool, opts.batchSize);
      if (released.length > 0) {
        deps.logger.info({ released: released.length }, 'sweeper released expired holds');
      }
    } catch (err) {
      deps.logger.error({ err }, 'hold sweep failed');
    }
  };

  const loop = (): void => {
    if (stopped) return;
    running = sweep().then(() => {
      if (!stopped) timer = setTimeout(loop, opts.intervalMs * (0.8 + Math.random() * 0.4));
    });
  };
  loop();

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
