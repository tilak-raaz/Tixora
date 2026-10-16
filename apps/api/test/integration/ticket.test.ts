import {
  createFakeMailer,
  drainOutbox,
  handleEmailJob,
  type EmailJobData,
  type JobSink,
} from '@bmt/jobs';
import { createFakeGateway } from '@bmt/payments';
import { createLogger } from '@bmt/platform';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { createTestDeps } from './helpers';
import { createCheckout, type Checkout } from './payment-fixtures';
import { signInAsUser } from './sessions';
import { deliver, paymentEvent, WEBHOOK_SECRET } from './webhooks';

/** The PDF ticket: attached to the confirmation email, and downloadable by its owner. */

const logger = createLogger({ name: 'test', level: 'silent' });
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

async function confirmed(): Promise<Checkout> {
  const c = await createCheckout(app, deps.pool, 2);
  await deliver(
    app,
    paymentEvent('payment.captured', { orderId: c.orderId, amountPaise: c.amountPaise }),
  );
  return c;
}

const ticketOf = (c: Checkout) =>
  c.agent
    .get(`/api/v1/bookings/${c.bookingId}/ticket`)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });

describe('downloading the ticket', () => {
  it('gives the owner of a confirmed booking a one-page PDF', async () => {
    const c = await confirmed();

    const res = await ticketOf(c);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="ticket-${c.bookingId.slice(0, 8).toUpperCase()}.pdf"`,
    );
    expect(res.headers['cache-control']).toBe('private, no-store');
    const pdf = res.body as Buffer;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1').match(/\/Type \/Page\b/g)).toHaveLength(1);
  });

  it('has no ticket for a booking that is not confirmed yet', async () => {
    const c = await createCheckout(app, deps.pool, 1);

    const res = await c.agent.get(`/api/v1/bookings/${c.bookingId}/ticket`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BOOKING_NOT_CONFIRMED');
  });

  it("hides another user's ticket", async () => {
    const c = await confirmed();
    const stranger = await signInAsUser(app);

    const res = await stranger.get(`/api/v1/bookings/${c.bookingId}/ticket`);

    expect(res.status).toBe(404);
  });

  it('requires a signed-in user', async () => {
    const c = await confirmed();
    const res = await request(app).get(`/api/v1/bookings/${c.bookingId}/ticket`);
    expect(res.status).toBe(401);
  });
});

describe('the confirmation email', () => {
  it('carries the ticket as a PDF attachment', async () => {
    const c = await confirmed();
    const jobs: EmailJobData[] = [];
    const capture: JobSink = { add: async (_name, data) => void jobs.push(data as EmailJobData) };
    await deps.pool.query('UPDATE outbox SET published_at = NULL WHERE aggregate_id = $1', [
      c.bookingId,
    ]);
    await drainOutbox(deps.pool, { email: capture, refunds: { add: async () => undefined } });
    const data = jobs.find((j) => j.bookingId === c.bookingId)!;
    const mailer = createFakeMailer();

    await handleEmailJob({ pool: deps.pool, mailer, logger }, { name: 'booking-confirmed', data });

    const [attachment] = mailer.sent[0]!.attachments ?? [];
    expect(attachment).toMatchObject({
      filename: `ticket-${c.bookingId.slice(0, 8).toUpperCase()}.pdf`,
      contentType: 'application/pdf',
    });
    expect(attachment!.content.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
