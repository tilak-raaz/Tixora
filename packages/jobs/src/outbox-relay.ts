import { withTransaction, type Logger, type OutboxTopic, type Pool } from '@bmt/platform';
import { startPeriodic, withTimeout, type Periodic } from './periodic';

/**
 * The outbox relay (ADR 0008): turns committed outbox rows into queue jobs.
 *
 * In one short transaction it locks a batch of unpublished rows (SKIP LOCKED,
 * so relays in several workers split the rows instead of queuing one twice),
 * queues a job for each with the outbox id as the job id, and marks the rows
 * published. The only call it makes while holding those locks is to Redis,
 * bounded by a timeout; never to Razorpay or an email provider.
 *
 * If the relay dies after queuing but before its commit, the rows stay
 * unpublished and the next relay queues them again under the same job ids,
 * which BullMQ ignores while the first jobs exist. Consumers deduplicate on
 * the outbox id as well, so delivery is at least once and handling is once.
 */

/** Where each topic goes. One event can feed several queues. */
export const OUTBOX_ROUTES: Record<OutboxTopic, { queue: 'email' | 'refunds'; job: string }[]> = {
  'booking.confirmed': [{ queue: 'email', job: 'booking-confirmed' }],
  'refund.recorded': [
    { queue: 'refunds', job: 'send' },
    { queue: 'email', job: 'refund-recorded' },
  ],
};

/** The part of a BullMQ queue the relay uses (so tests can wrap it). */
export interface JobSink {
  add(name: string, data: object, opts: { jobId: string }): Promise<unknown>;
}

export type RelayQueues = Record<'email' | 'refunds', JobSink>;

/** Relays one batch. Returns how many events it published. */
export async function relayOnce(
  pool: Pool,
  queues: RelayQueues,
  opts: { batchSize?: number; timeoutMs?: number } = {},
): Promise<number> {
  const { batchSize = 100, timeoutMs = 2_000 } = opts;
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      topic: OutboxTopic;
      payload: Record<string, unknown>;
      requestId: string | null;
    }>(
      `SELECT id, topic, payload, request_id AS "requestId"
       FROM outbox
       WHERE published_at IS NULL
       ORDER BY created_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );
    for (const event of rows) {
      for (const route of OUTBOX_ROUTES[event.topic]) {
        await withTimeout(
          queues[route.queue].add(
            route.job,
            { ...event.payload, outboxId: event.id, requestId: event.requestId },
            { jobId: event.id },
          ),
          timeoutMs,
        );
      }
    }
    if (rows.length > 0) {
      await tx.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1::uuid[])', [
        rows.map((r) => r.id),
      ]);
    }
    return rows.length;
  });
}

/** Relays batch after batch until a batch comes back short. */
export async function drainOutbox(
  pool: Pool,
  queues: RelayQueues,
  opts: { batchSize?: number; timeoutMs?: number } = {},
): Promise<number> {
  const batchSize = opts.batchSize ?? 100;
  let total = 0;
  for (;;) {
    const relayed = await relayOnce(pool, queues, { ...opts, batchSize });
    total += relayed;
    if (relayed < batchSize) return total;
  }
}

/**
 * Polls the outbox every `intervalMs` (default 500 ms, so a confirmation email
 * is queued within about half a second of the payment). A failed run (Redis
 * down) leaves the rows unpublished for the next one.
 */
export function startOutboxRelay(
  deps: { pool: Pool; queues: RelayQueues; logger: Logger },
  opts: { intervalMs?: number; batchSize?: number } = {},
): Periodic {
  return startPeriodic(
    'outbox relay',
    async () => {
      const relayed = await drainOutbox(deps.pool, deps.queues, { batchSize: opts.batchSize });
      if (relayed > 0) deps.logger.debug({ relayed }, 'outbox relayed');
    },
    { intervalMs: opts.intervalMs ?? 500, logger: deps.logger },
  );
}
