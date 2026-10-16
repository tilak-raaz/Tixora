import { randomUUID } from 'node:crypto';
import {
  createEmailQueue,
  createEmailWorker,
  createFakeMailer,
  drainOutbox,
  handleEmailJob,
  type EmailJobData,
  type EmailJobName,
  type FakeMailer,
  type JobSink,
} from '@bmt/jobs';
import { createFakeGateway } from '@bmt/payments';
import { createLogger } from '@bmt/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { createTestDeps } from './helpers';
import { createCheckout, expireHoldNow, type Checkout } from './payment-fixtures';
import { deliver, paymentEvent, WEBHOOK_SECRET } from './webhooks';

/**
 * Emails from outbox events: what they say, and that each reaches the buyer
 * once however often its job runs.
 */

const logger = createLogger({ name: 'test', level: 'silent' });
let deps: ReturnType<typeof createTestDeps>;
let app: ReturnType<typeof createApp>;
let mailer: FakeMailer;

beforeAll(() => {
  deps = createTestDeps();
  app = createApp({
    ...deps,
    paymentGateway: createFakeGateway(),
    paymentWebhookSecret: WEBHOOK_SECRET,
  });
});
beforeEach(() => {
  mailer = createFakeMailer();
});
afterAll(async () => {
  await deps.close();
});

async function buyerEmail(bookingId: string): Promise<string> {
  const { rows } = await deps.pool.query<{ email: string }>(
    'SELECT u.email FROM bookings b JOIN users u ON u.id = b.user_id WHERE b.id = $1',
    [bookingId],
  );
  return rows[0]!.email;
}

/** The email job the relay would queue for this booking's or refund's event. */
async function emailJobFor(
  aggregateId: string,
): Promise<{ name: EmailJobName; data: EmailJobData }> {
  const jobs: { name: EmailJobName; data: EmailJobData }[] = [];
  const email: JobSink = {
    async add(name, data) {
      jobs.push({ name: name as EmailJobName, data: data as EmailJobData });
    },
  };
  const ignore: JobSink = { add: async () => undefined };
  // Republish this one event to a capturing sink (other files' events go nowhere).
  await deps.pool.query('UPDATE outbox SET published_at = NULL WHERE aggregate_id = $1', [
    aggregateId,
  ]);
  await drainOutbox(deps.pool, { email, refunds: ignore });
  const job = jobs.find((j) => j.data.bookingId === aggregateId || j.data.refundId === aggregateId);
  if (!job) throw new Error(`no email job for ${aggregateId}`);
  return job;
}

async function confirmed(): Promise<Checkout> {
  const c = await createCheckout(app, deps.pool, 2);
  await deliver(
    app,
    paymentEvent('payment.captured', { orderId: c.orderId, amountPaise: c.amountPaise }),
  );
  return c;
}

async function refunded(): Promise<Checkout & { refundId: string }> {
  const c = await createCheckout(app, deps.pool, 1);
  await expireHoldNow(deps.pool, c.bookingId);
  await deliver(
    app,
    paymentEvent('payment.captured', { orderId: c.orderId, amountPaise: c.amountPaise }),
  );
  const { rows } = await deps.pool.query<{ id: string }>(
    `SELECT r.id FROM refunds r JOIN payments p ON p.id = r.payment_id
     JOIN payment_orders po ON po.id = p.order_id WHERE po.booking_id = $1`,
    [c.bookingId],
  );
  return { ...c, refundId: rows[0]!.id };
}

describe('what the emails say', () => {
  it('confirms the booking to the buyer with the show, seats, total and reference', async () => {
    const c = await confirmed();
    const job = await emailJobFor(c.bookingId);

    expect(await handleEmailJob({ pool: deps.pool, mailer, logger }, job)).toBe('sent');

    expect(mailer.sent).toHaveLength(1);
    const email = mailer.sent[0]!;
    expect(email.to).toBe(await buyerEmail(c.bookingId));
    expect(email.subject).toMatch(/^Booked: Movie /);
    expect(email.text).toContain('Seats: A1, A2');
    expect(email.text).toContain('₹400.00');
    expect(email.text).toContain(c.bookingId.slice(0, 8).toUpperCase());
    expect(email.idempotencyKey).toBe(job.data.outboxId);
  });

  it('tells the buyer why their payment is being refunded, and how much', async () => {
    const r = await refunded();
    const job = await emailJobFor(r.refundId);

    await handleEmailJob({ pool: deps.pool, mailer, logger }, job);

    expect(job.name).toBe('refund-recorded');
    expect(mailer.sent[0]!.subject).toContain('Refund on its way: ₹200.00');
    expect(mailer.sent[0]!.text).toContain('after your seats were released');
  });

  it('escapes names in the HTML', async () => {
    const c = await confirmed();
    await deps.pool.query(
      `UPDATE users SET name = '<script>x</script>'
       WHERE id = (SELECT user_id FROM bookings WHERE id = $1)`,
      [c.bookingId],
    );

    await handleEmailJob({ pool: deps.pool, mailer, logger }, await emailJobFor(c.bookingId));

    expect(mailer.sent[0]!.html).not.toContain('<script>');
    expect(mailer.sent[0]!.html).toContain('&lt;script&gt;');
  });
});

describe('sending each email once', () => {
  it('skips a message it has already sent', async () => {
    const c = await confirmed();
    const job = await emailJobFor(c.bookingId);

    expect(await handleEmailJob({ pool: deps.pool, mailer, logger }, job)).toBe('sent');
    expect(await handleEmailJob({ pool: deps.pool, mailer, logger }, job)).toBe('already_sent');

    expect(mailer.attempts).toBe(1);
  });

  it('sends nothing twice when the worker dies after sending but before recording it', async () => {
    const c = await confirmed();
    const job = await emailJobFor(c.bookingId);
    await handleEmailJob({ pool: deps.pool, mailer, logger }, job);
    // As if the worker died between the provider accepting the email and the INSERT.
    await deps.pool.query('DELETE FROM processed_messages WHERE message_id = $1', [
      job.data.outboxId,
    ]);

    expect(await handleEmailJob({ pool: deps.pool, mailer, logger }, job)).toBe('sent');

    expect(mailer.attempts).toBe(2); // the retry did call the provider...
    expect(mailer.sent).toHaveLength(1); // ...which dropped it by its idempotency key
  });

  it('fails the job when the provider is down, so it is retried, and records nothing', async () => {
    const c = await confirmed();
    const job = await emailJobFor(c.bookingId);
    mailer.failNext();

    await expect(handleEmailJob({ pool: deps.pool, mailer, logger }, job)).rejects.toThrow();
    const { rowCount } = await deps.pool.query(
      'SELECT 1 FROM processed_messages WHERE message_id = $1',
      [job.data.outboxId],
    );
    expect(rowCount).toBe(0);

    expect(await handleEmailJob({ pool: deps.pool, mailer, logger }, job)).toBe('sent');
  });

  it('delivers the confirmation end to end: webhook, outbox, relay, queue, worker', async () => {
    const prefix = `bmt-test-${randomUUID()}`;
    const queue = createEmailQueue(inject('redisUrl'), { prefix });
    const worker = createEmailWorker(
      { redisUrl: inject('redisUrl'), pool: deps.pool, mailer, logger },
      { prefix },
    );

    try {
      const c = await confirmed();
      await drainOutbox(deps.pool, { email: queue, refunds: { add: async () => undefined } });

      const to = await buyerEmail(c.bookingId);
      await vi.waitFor(() => expect(mailer.sent.map((m) => m.to)).toContain(to), {
        timeout: 10_000,
        interval: 100,
      });
      expect(mailer.sent.filter((m) => m.to === to)).toHaveLength(1);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});
