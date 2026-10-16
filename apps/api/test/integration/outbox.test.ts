import { randomUUID } from 'node:crypto';
import { createEmailQueue, drainOutbox, relayOnce, type JobSink } from '@bmt/jobs';
import { applyCapturedPayment, createFakeGateway } from '@bmt/payments';
import { createLogger, createPool, withTransaction, writeOutbox, type Pool } from '@bmt/platform';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../../src/app';
import { createTestDeps } from './helpers';
import { bookingStatus, createCheckout, expireHoldNow, refundsOf } from './payment-fixtures';
import { deliver, paymentEvent, WEBHOOK_SECRET } from './webhooks';

/**
 * The transactional outbox (ADR 0008): an event exists if and only if its
 * change committed, and the relay queues each one once, however many relays
 * run and wherever one dies.
 *
 * Other test files leave unpublished events behind, and every relay here
 * picks those up too, so assertions look only at this file's events.
 */

const logger = createLogger({ name: 'test', level: 'silent' });
const prefix = `bmt-test-${randomUUID()}`;
let deps: ReturnType<typeof createTestDeps>;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  deps = createTestDeps();
  app = createApp({
    ...deps,
    paymentGateway: createFakeGateway(),
    paymentWebhookSecret: WEBHOOK_SECRET,
  });
});
afterAll(async () => {
  await deps.close();
});

interface OutboxRow {
  id: string;
  topic: string;
  payload: Record<string, unknown>;
  requestId: string | null;
  published: boolean;
}

async function eventsAbout(...aggregateIds: string[]): Promise<OutboxRow[]> {
  const { rows } = await deps.pool.query<OutboxRow>(
    `SELECT id, topic, payload, request_id AS "requestId", published_at IS NOT NULL AS published
     FROM outbox WHERE aggregate_id = ANY($1::uuid[]) ORDER BY created_at`,
    [aggregateIds],
  );
  return rows;
}

/** A sink that only records what it was asked to queue. */
function recordingSink(): JobSink & { jobIds: string[] } {
  const jobIds: string[] = [];
  return {
    jobIds,
    async add(_name, _data, opts) {
      jobIds.push(opts.jobId);
    },
  };
}

/** Events nobody else touches: written straight to the outbox. */
async function writeEvents(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const bookingId = randomUUID();
    ids.push(
      await writeOutbox(deps.pool, 'booking.confirmed', { bookingId }, { aggregateId: bookingId }),
    );
  }
  return ids;
}

describe('writing events', () => {
  it('announces a confirmation in the same commit, carrying the request id', async () => {
    const c = await createCheckout(app, deps.pool);
    const requestId = `req-${randomUUID()}`;

    await deliver(
      app,
      paymentEvent('payment.captured', { orderId: c.orderId, amountPaise: c.amountPaise }),
      { requestId },
    );

    expect(await bookingStatus(deps.pool, c.bookingId)).toBe('CONFIRMED');
    expect(await eventsAbout(c.bookingId)).toMatchObject([
      {
        topic: 'booking.confirmed',
        payload: { bookingId: c.bookingId },
        requestId,
        published: false,
      },
    ]);
  });

  it('announces a refund it records', async () => {
    const c = await createCheckout(app, deps.pool);
    await expireHoldNow(deps.pool, c.bookingId);

    await deliver(
      app,
      paymentEvent('payment.captured', { orderId: c.orderId, amountPaise: c.amountPaise }),
    );

    const [refund] = await refundsOf(deps.pool, c.bookingId);
    expect(await eventsAbout(refund!.id)).toMatchObject([
      {
        topic: 'refund.recorded',
        payload: { refundId: refund!.id, bookingId: c.bookingId, reason: 'HOLD_ENDED' },
      },
    ]);
  });

  it('leaves no event behind when the change rolls back', async () => {
    const c = await createCheckout(app, deps.pool);

    await expect(
      withTransaction(deps.pool, async (tx) => {
        await applyCapturedPayment(tx, {
          razorpayPaymentId: `pay_${randomUUID().slice(0, 8)}`,
          razorpayOrderId: c.orderId,
          amountPaise: c.amountPaise,
          currency: 'INR',
          capturedAt: new Date(),
        });
        throw new Error('crash after confirming, before commit');
      }),
    ).rejects.toThrow('crash');

    expect(await bookingStatus(deps.pool, c.bookingId)).toBe('PENDING_PAYMENT');
    expect(await eventsAbout(c.bookingId)).toEqual([]);
  });
});

describe('the relay', () => {
  it('queues each event to its queues under the outbox id, then marks it published', async () => {
    const queue = createEmailQueue(inject('redisUrl'), { prefix });
    const refunds = recordingSink();
    const c = await createCheckout(app, deps.pool);
    await deliver(
      app,
      paymentEvent('payment.captured', { orderId: c.orderId, amountPaise: c.amountPaise }),
    );
    const [event] = await eventsAbout(c.bookingId);

    try {
      await drainOutbox(deps.pool, { email: queue, refunds });

      const job = await queue.getJob(event!.id);
      expect(job?.name).toBe('booking-confirmed');
      expect(job?.data).toMatchObject({ bookingId: c.bookingId, outboxId: event!.id });
      expect(refunds.jobIds).not.toContain(event!.id); // a confirmation is not a refund
      expect((await eventsAbout(c.bookingId))[0]!.published).toBe(true);
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it('sends a recorded refund to both the refund queue and the email queue', async () => {
    const refundId = randomUUID();
    const eventId = await writeOutbox(
      deps.pool,
      'refund.recorded',
      { refundId, bookingId: randomUUID(), reason: 'HOLD_ENDED' },
      { aggregateId: refundId },
    );
    const email = recordingSink();
    const refunds = recordingSink();

    await drainOutbox(deps.pool, { email, refunds });

    expect(email.jobIds).toContain(eventId);
    expect(refunds.jobIds).toContain(eventId);
  });

  it('relays each event exactly once when two relays run at the same moment', async () => {
    const ours = new Set(await writeEvents(30));
    const relays: Pool[] = Array.from({ length: 2 }, () =>
      createPool({
        connectionString: inject('databaseUrl'),
        max: 2,
        applicationName: 'bmt-test',
        logger,
      }),
    );
    const sinks = relays.map(() => recordingSink());

    try {
      await Promise.all(
        relays.map((pool, i) =>
          drainOutbox(pool, { email: sinks[i]!, refunds: recordingSink() }, { batchSize: 5 }),
        ),
      );
    } finally {
      await Promise.all(relays.map((p) => p.end()));
    }

    const queued = sinks.flatMap((s) => s.jobIds).filter((id) => ours.has(id));
    expect(queued).toHaveLength(30);
    expect(new Set(queued).size).toBe(30);
  });

  it('creates no duplicate job when a relay dies after queuing but before committing', async () => {
    const queue = createEmailQueue(inject('redisUrl'), { prefix: `${prefix}-crash` });
    const [eventId] = await writeEvents(1);
    // Queues the job for real, then "dies" before the relay can mark the row published.
    const dying: JobSink = {
      async add(name, data, opts) {
        await queue.add(name as 'booking-confirmed', data as never, opts);
        if (opts.jobId === eventId) throw new Error('relay killed');
      },
    };

    try {
      await expect(
        relayOnce(deps.pool, { email: dying, refunds: recordingSink() }, { batchSize: 1_000 }),
      ).rejects.toThrow('relay killed');
      expect((await eventsAbout(...(await aggregateOf(eventId!))))[0]!.published).toBe(false);

      await drainOutbox(deps.pool, { email: queue, refunds: recordingSink() });

      const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'completed']);
      expect(jobs.filter((j) => j.data.outboxId === eventId)).toHaveLength(1);
      expect((await eventsAbout(...(await aggregateOf(eventId!))))[0]!.published).toBe(true);
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it('keeps every event while Redis is down, and relays them once it is back', async () => {
    const [eventId] = await writeEvents(1);
    const down: JobSink = {
      async add() {
        throw new Error('connect ECONNREFUSED');
      },
    };

    await expect(drainOutbox(deps.pool, { email: down, refunds: down })).rejects.toThrow();
    expect((await eventsAbout(...(await aggregateOf(eventId!))))[0]!.published).toBe(false);

    const email = recordingSink();
    await drainOutbox(deps.pool, { email, refunds: recordingSink() });
    expect(email.jobIds).toContain(eventId);
  });
});

async function aggregateOf(eventId: string): Promise<string[]> {
  const { rows } = await deps.pool.query<{ aggregateId: string }>(
    'SELECT aggregate_id AS "aggregateId" FROM outbox WHERE id = $1',
    [eventId],
  );
  return rows.map((r) => r.aggregateId);
}
