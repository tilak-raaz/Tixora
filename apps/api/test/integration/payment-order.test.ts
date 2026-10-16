import { randomUUID } from 'node:crypto';
import { createFakeGateway, FAKE_KEY_ID, type FakeGateway } from '@bmt/payments';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { createShowFixture } from './fixtures';
import { createTestDeps } from './helpers';
import { signInAsUser, type Agent } from './sessions';

/** POST /bookings/:id/payment-order and the checkout callback check, against the fake Razorpay. */

let deps: ReturnType<typeof createTestDeps>;
let gateway: FakeGateway;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  deps = createTestDeps();
});
beforeEach(() => {
  gateway = createFakeGateway();
  app = createApp({ ...deps, paymentGateway: gateway });
});
afterAll(async () => {
  await deps.close();
});

/** A signed-in buyer holding `seats` seats at ₹200 each. */
async function heldBooking(seats = 2): Promise<{ agent: Agent; bookingId: string }> {
  const agent = await signInAsUser(app);
  const { showId, seatIds } = await createShowFixture(deps.pool, seats);
  const res = await agent
    .post('/api/v1/bookings')
    .set('Idempotency-Key', randomUUID())
    .send({ showId, seatIds });
  expect(res.status).toBe(201);
  return { agent, bookingId: res.body.booking.id };
}

const orderFor = (agent: Agent, bookingId: string) =>
  agent.post(`/api/v1/bookings/${bookingId}/payment-order`).send();

async function storedOrders(bookingId: string): Promise<string[]> {
  const { rows } = await deps.pool.query<{ razorpay_order_id: string }>(
    'SELECT razorpay_order_id FROM payment_orders WHERE booking_id = $1',
    [bookingId],
  );
  return rows.map((r) => r.razorpay_order_id);
}

describe('creating the payment order', () => {
  it('requires a signed-in user', async () => {
    const res = await request(app).post(`/api/v1/bookings/${randomUUID()}/payment-order`);
    expect(res.status).toBe(401);
  });

  it('creates the order once, for the booking total, and returns it on every later call', async () => {
    const { agent, bookingId } = await heldBooking(2);

    const first = await orderFor(agent, bookingId);
    const second = await orderFor(agent, bookingId);

    expect(first.status).toBe(201);
    expect(first.body.order).toMatchObject({
      bookingId,
      amountPaise: 40_000,
      currency: 'INR',
      keyId: FAKE_KEY_ID,
    });
    expect(second.status).toBe(200);
    expect(second.body.order.razorpayOrderId).toBe(first.body.order.razorpayOrderId);
    expect(gateway.calls.createOrder).toBe(1);
    expect(gateway.orders[0]!.receipt).toBe(bookingId);
    expect(await storedOrders(bookingId)).toEqual([first.body.order.razorpayOrderId]);
  });

  it('gives racing requests the same order', async () => {
    const { agent, bookingId } = await heldBooking(1);

    const results = await Promise.all(Array.from({ length: 5 }, () => orderFor(agent, bookingId)));

    const ids = new Set(results.map((r) => r.body.order?.razorpayOrderId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await storedOrders(bookingId)).toEqual([...ids]);
  });

  it('recovers an order that an earlier attempt created at Razorpay but never stored', async () => {
    const { agent, bookingId } = await heldBooking(1);
    // As if the API crashed right after Razorpay answered.
    const lost = await gateway.createOrder({ amountPaise: 20_000, receipt: bookingId });

    const res = await orderFor(agent, bookingId);

    expect(res.status).toBe(201);
    expect(res.body.order.razorpayOrderId).toBe(lost.id);
    expect(gateway.calls.createOrder).toBe(1); // only the "crashed" one
  });

  it("hides another user's booking", async () => {
    const { bookingId } = await heldBooking(1);
    const stranger = await signInAsUser(app);
    const res = await orderFor(stranger, bookingId);
    expect(res.status).toBe(404);
  });

  it('refuses a released or expired hold', async () => {
    const released = await heldBooking(1);
    await released.agent.delete(`/api/v1/bookings/${released.bookingId}/hold`);
    expect((await orderFor(released.agent, released.bookingId)).body.error.code).toBe(
      'HOLD_NOT_ACTIVE',
    );

    const expired = await heldBooking(1);
    await deps.pool.query(
      `UPDATE bookings SET created_at = now() - interval '10 minutes',
                           expires_at = now() - interval '1 second' WHERE id = $1`,
      [expired.bookingId],
    );
    const res = await orderFor(expired.agent, expired.bookingId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('HOLD_NOT_ACTIVE');
    expect(gateway.calls.createOrder).toBe(0);
  });

  it('refuses a new order with under a minute left, but still returns an existing one', async () => {
    const late = await heldBooking(1);
    const early = await heldBooking(1);
    await orderFor(early.agent, early.bookingId);
    await deps.pool.query(
      `UPDATE bookings SET created_at = now() - interval '5 minutes',
                           expires_at = now() + interval '30 seconds' WHERE id = ANY($1::uuid[])`,
      [[late.bookingId, early.bookingId]],
    );

    const refused = await orderFor(late.agent, late.bookingId);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('HOLD_ENDING_SOON');

    const existing = await orderFor(early.agent, early.bookingId);
    expect(existing.status).toBe(200);
  });

  it('answers 502 when Razorpay is down, stores nothing, and works on retry', async () => {
    const { agent, bookingId } = await heldBooking(1);
    gateway.failNext();

    const down = await orderFor(agent, bookingId);
    expect(down.status).toBe(502);
    expect(down.body.error.code).toBe('PAYMENT_GATEWAY_ERROR');
    expect(await storedOrders(bookingId)).toEqual([]);

    expect((await orderFor(agent, bookingId)).status).toBe(201);
  });

  it('answers 503 when the server has no Razorpay keys', async () => {
    const unconfigured = createApp(deps);
    const agent = await signInAsUser(unconfigured);
    const res = await agent.post(`/api/v1/bookings/${randomUUID()}/payment-order`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('checking the checkout callback', () => {
  const verify = (agent: Agent, bookingId: string, body: object) =>
    agent.post(`/api/v1/bookings/${bookingId}/payment/verify`).send(body);

  it('accepts a genuine signature and leaves the booking for the webhook to confirm', async () => {
    const { agent, bookingId } = await heldBooking(1);
    const { body } = await orderFor(agent, bookingId);
    const orderId = body.order.razorpayOrderId;
    const paid = gateway.checkoutSuccess(orderId);

    const res = await verify(agent, bookingId, {
      razorpayOrderId: orderId,
      razorpayPaymentId: paid.paymentId,
      razorpaySignature: paid.signature,
    });

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(res.body.booking.status).toBe('PENDING_PAYMENT');
  });

  it('rejects a signature for a different payment', async () => {
    const { agent, bookingId } = await heldBooking(1);
    const { body } = await orderFor(agent, bookingId);
    const orderId = body.order.razorpayOrderId;
    const paid = gateway.checkoutSuccess(orderId);

    const res = await verify(agent, bookingId, {
      razorpayOrderId: orderId,
      razorpayPaymentId: 'pay_someoneelse',
      razorpaySignature: paid.signature,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PAYMENT_SIGNATURE_INVALID');
  });

  it("rejects another booking's order", async () => {
    const a = await heldBooking(1);
    const b = await heldBooking(1);
    await orderFor(a.agent, a.bookingId);
    const other = await orderFor(b.agent, b.bookingId);
    const paid = gateway.checkoutSuccess(other.body.order.razorpayOrderId);

    const res = await verify(a.agent, a.bookingId, {
      razorpayOrderId: other.body.order.razorpayOrderId,
      razorpayPaymentId: paid.paymentId,
      razorpaySignature: paid.signature,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});
