import { randomUUID } from 'node:crypto';
import { createFakeGateway, type FakeGateway } from '@bmt/payments';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { createTestDeps } from './helpers';
import { checkInvariants } from './invariants';
import { createCheckout } from './payment-fixtures';
import { signInAsUser } from './sessions';

/**
 * PAYMENT_GATEWAY=fake: the web app and end-to-end tests pay without Razorpay. The fake answers
 * like Checkout and then delivers a signed webhook through the real handler, so the booking is
 * still confirmed by the webhook path, never by the browser.
 */

const SECRET = 'fake-mode-webhook-secret';
let deps: ReturnType<typeof createTestDeps>;
let gateway: FakeGateway;
let app: ReturnType<typeof createApp>;
const showIds: string[] = [];

beforeAll(() => {
  deps = createTestDeps();
});
beforeEach(() => {
  gateway = createFakeGateway();
  app = createApp({
    ...deps,
    paymentGateway: gateway,
    paymentWebhookSecret: SECRET,
    payment: { checkout: 'fake' },
    fakePayments: { gateway, webhookDelayMs: 0 },
  });
});
afterAll(async () => {
  expect(await checkInvariants(deps.pool, showIds)).toEqual([]);
  await deps.close();
});

async function statusOf(bookingId: string): Promise<string> {
  const { rows } = await deps.pool.query<{ status: string }>(
    'SELECT status FROM bookings WHERE id = $1',
    [bookingId],
  );
  return rows[0]!.status;
}

describe('fake payments', () => {
  it('tells the browser to open the fake checkout', async () => {
    const checkout = await createCheckout(app, deps.pool);
    showIds.push(checkout.showId);
    const order = await checkout.agent.post(`/api/v1/bookings/${checkout.bookingId}/payment-order`);
    expect(order.body.order.checkout).toBe('fake');
  });

  it('a paid fake payment confirms the booking through the webhook, and verifies like Checkout', async () => {
    const checkout = await createCheckout(app, deps.pool, 2);
    showIds.push(checkout.showId);

    const paid = await checkout.agent
      .post(`/api/v1/dev/fake-payments/${checkout.bookingId}`)
      .send({ outcome: 'paid' });
    expect(paid.status).toBe(200);
    expect(await statusOf(checkout.bookingId)).toBe('CONFIRMED');

    // The browser's half: the same signature check as after Razorpay Checkout.
    const verified = await checkout.agent
      .post(`/api/v1/bookings/${checkout.bookingId}/payment/verify`)
      .send(paid.body);
    expect(verified.status).toBe(200);
    expect(verified.body.verified).toBe(true);

    // It went through the webhook table, like a real delivery.
    const { rows } = await deps.pool.query(
      `SELECT 1 FROM payment_webhook_events
       WHERE payload->'payload'->'payment'->'entity'->>'order_id' = $1`,
      [checkout.orderId],
    );
    expect(rows).toHaveLength(1);
  });

  it('a failed fake payment leaves the hold waiting for another try', async () => {
    const checkout = await createCheckout(app, deps.pool);
    showIds.push(checkout.showId);

    const failed = await checkout.agent
      .post(`/api/v1/dev/fake-payments/${checkout.bookingId}`)
      .send({ outcome: 'failed' });
    expect(failed.body).toEqual({ failed: true });
    expect(await statusOf(checkout.bookingId)).toBe('PENDING_PAYMENT');
  });

  it("refuses someone else's booking and a booking without an order", async () => {
    const checkout = await createCheckout(app, deps.pool);
    showIds.push(checkout.showId);
    const stranger = await signInAsUser(app);
    const res = await stranger
      .post(`/api/v1/dev/fake-payments/${checkout.bookingId}`)
      .send({ outcome: 'paid' });
    expect(res.status).toBe(404);

    const unknown = await checkout.agent
      .post(`/api/v1/dev/fake-payments/${randomUUID()}`)
      .send({ outcome: 'paid' });
    expect(unknown.status).toBe(404);
  });

  it('does not exist unless fake payments are on', async () => {
    const real = createApp({ ...deps, paymentGateway: gateway, paymentWebhookSecret: SECRET });
    const res = await request(real)
      .post(`/api/v1/dev/fake-payments/${randomUUID()}`)
      .send({ outcome: 'paid' });
    expect(res.status).toBe(404);
  });
});
