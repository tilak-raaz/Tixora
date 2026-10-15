import { randomUUID } from 'node:crypto';
import { expireHold } from '@bmt/jobs';
import { createFakeGateway } from '@bmt/payments';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { createShowFixture } from './fixtures';
import { createTestDeps } from './helpers';
import { checkInvariants } from './invariants';
import { signInAsUser, type Agent } from './sessions';
import { deliver, paymentEvent, WEBHOOK_SECRET } from './webhooks';

/**
 * The webhook and the confirm transaction: duplicate, reordered, late and
 * racing events. After every test, the money and seat invariants must hold.
 */

let deps: ReturnType<typeof createTestDeps>;
let app: ReturnType<typeof createApp>;
const shows: string[] = [];

beforeAll(() => {
  deps = createTestDeps();
  app = createApp({
    ...deps,
    paymentGateway: createFakeGateway(),
    paymentWebhookSecret: WEBHOOK_SECRET,
  });
});
afterEach(async () => {
  expect(await checkInvariants(deps.pool, shows)).toEqual([]);
});
afterAll(async () => {
  await deps.close();
});

interface Checkout {
  agent: Agent;
  showId: string;
  seatIds: string[];
  bookingId: string;
  orderId: string;
  amountPaise: number;
}

/** A buyer who has held `seats` seats (₹200 each) and opened Checkout for them. */
async function checkout(seats = 2): Promise<Checkout> {
  const agent = await signInAsUser(app);
  const { showId, seatIds } = await createShowFixture(deps.pool, seats);
  shows.push(showId);
  const hold = await agent
    .post('/api/v1/bookings')
    .set('Idempotency-Key', randomUUID())
    .send({ showId, seatIds });
  expect(hold.status).toBe(201);
  const bookingId = hold.body.booking.id;
  const order = await agent.post(`/api/v1/bookings/${bookingId}/payment-order`);
  expect(order.status).toBe(201);
  return {
    agent,
    showId,
    seatIds,
    bookingId,
    orderId: order.body.order.razorpayOrderId,
    amountPaise: order.body.order.amountPaise,
  };
}

const captured = (c: Checkout, paymentId?: string) =>
  paymentEvent('payment.captured', { orderId: c.orderId, amountPaise: c.amountPaise, paymentId });

async function stateOf(bookingId: string) {
  const { rows } = await deps.pool.query<{ status: string }>(
    'SELECT status FROM bookings WHERE id = $1',
    [bookingId],
  );
  const seats = await deps.pool.query<{ status: string }>(
    `SELECT ss.status FROM booking_seats bs JOIN show_seats ss ON ss.id = bs.show_seat_id
     WHERE bs.booking_id = $1 AND ss.booking_id = $1 ORDER BY ss.id`,
    [bookingId],
  );
  const payments = await deps.pool.query<{ applied: boolean; reason: string | null }>(
    `SELECT p.applied, r.reason FROM payments p
     JOIN payment_orders po ON po.id = p.order_id
     LEFT JOIN refunds r ON r.payment_id = p.id
     WHERE po.booking_id = $1 ORDER BY p.created_at`,
    [bookingId],
  );
  return {
    status: rows[0]!.status,
    seats: seats.rows.map((s) => s.status),
    payments: payments.rows,
  };
}

/** Moves a hold 10 minutes into the past. */
async function expire(bookingId: string): Promise<void> {
  await deps.pool.query(
    `UPDATE bookings SET created_at = now() - interval '10 minutes',
                         expires_at = now() - interval '1 minute' WHERE id = $1`,
    [bookingId],
  );
  await deps.pool.query(
    "UPDATE show_seats SET held_until = now() - interval '1 minute' WHERE booking_id = $1",
    [bookingId],
  );
}

describe('authenticity', () => {
  it('rejects a bad signature and stores nothing', async () => {
    const c = await checkout(1);
    const eventId = `evt_${randomUUID()}`;
    const res = await deliver(app, captured(c), { eventId, signature: 'f'.repeat(64) });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PAYMENT_SIGNATURE_INVALID');
    const { rowCount } = await deps.pool.query(
      'SELECT 1 FROM payment_webhook_events WHERE event_id = $1',
      [eventId],
    );
    expect(rowCount).toBe(0);
    expect((await stateOf(c.bookingId)).status).toBe('PENDING_PAYMENT');
  });

  it('rejects an event signed with another secret', async () => {
    const c = await checkout(1);
    const res = await deliver(app, captured(c), { secret: 'not-our-secret' });
    expect(res.status).toBe(400);
  });

  it('answers 503 when no webhook secret is configured', async () => {
    const unconfigured = createApp(deps);
    const res = await deliver(unconfigured, { event: 'payment.captured' });
    expect(res.status).toBe(503);
  });
});

describe('confirming a booking', () => {
  it('confirms the booking and books its seats when the payment is captured', async () => {
    const c = await checkout(2);

    const res = await deliver(app, captured(c));

    expect(res.status).toBe(200);
    expect(await stateOf(c.bookingId)).toEqual({
      status: 'CONFIRMED',
      seats: ['BOOKED', 'BOOKED'],
      payments: [{ applied: true, reason: null }],
    });
    const view = await c.agent.get(`/api/v1/bookings/${c.bookingId}`);
    expect(view.body.booking.status).toBe('CONFIRMED');
  });

  it('applies a redelivered event once', async () => {
    const c = await checkout(1);
    const event = captured(c);
    const eventId = `evt_${randomUUID()}`;

    for (let i = 0; i < 3; i++) {
      expect((await deliver(app, event, { eventId })).status).toBe(200);
    }

    expect((await stateOf(c.bookingId)).payments).toEqual([{ applied: true, reason: null }]);
  });

  it('applies a payment once when both payment.captured and order.paid report it', async () => {
    const c = await checkout(1);
    const paymentId = `pay_${randomUUID().slice(0, 8)}`;

    await deliver(app, captured(c, paymentId));
    await deliver(
      app,
      paymentEvent('order.paid', { orderId: c.orderId, amountPaise: c.amountPaise, paymentId }),
    );

    expect(await stateOf(c.bookingId)).toMatchObject({
      status: 'CONFIRMED',
      payments: [{ applied: true, reason: null }],
    });
  });

  it('applies the event once when ten copies arrive at the same moment', async () => {
    const c = await checkout(2);
    const event = captured(c);
    const eventId = `evt_${randomUUID()}`;

    const results = await Promise.all(
      Array.from({ length: 10 }, () => deliver(app, event, { eventId })),
    );

    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect((await stateOf(c.bookingId)).payments).toHaveLength(1);
  });

  it('ignores a failed attempt and confirms on the later successful one', async () => {
    const c = await checkout(1);

    await deliver(
      app,
      paymentEvent('payment.failed', { orderId: c.orderId, amountPaise: c.amountPaise }),
    );
    expect((await stateOf(c.bookingId)).status).toBe('PENDING_PAYMENT');

    await deliver(app, captured(c));
    expect((await stateOf(c.bookingId)).status).toBe('CONFIRMED');
  });

  it('ignores a payment for an order this app did not create', async () => {
    const res = await deliver(
      app,
      paymentEvent('payment.captured', { orderId: 'order_notours', amountPaise: 100 }),
    );
    expect(res.status).toBe(200);
  });
});

describe('refunding instead of confirming', () => {
  it('refunds a payment that arrives after the hold ran out, and confirms nothing', async () => {
    const c = await checkout(1);
    await expire(c.bookingId);

    await deliver(app, captured(c));

    expect(await stateOf(c.bookingId)).toEqual({
      status: 'PENDING_PAYMENT', // the expiry job finishes the job; GET /bookings already says EXPIRED
      seats: ['HELD'],
      payments: [{ applied: false, reason: 'HOLD_ENDED' }],
    });
  });

  it('refunds a late payment whose seats another buyer has already taken', async () => {
    const c = await checkout(1);
    await expire(c.bookingId);
    await expireHold(deps.pool, c.bookingId);
    const rival = await signInAsUser(app);
    const rivalHold = await rival
      .post('/api/v1/bookings')
      .set('Idempotency-Key', randomUUID())
      .send({ showId: c.showId, seatIds: c.seatIds });
    expect(rivalHold.status).toBe(201);

    await deliver(app, captured(c));

    expect(await stateOf(c.bookingId)).toMatchObject({
      status: 'EXPIRED',
      payments: [{ applied: false, reason: 'HOLD_ENDED' }],
    });
    expect((await stateOf(rivalHold.body.booking.id)).seats).toEqual(['HELD']);
  });

  it('refunds a payment for a hold the buyer released', async () => {
    const c = await checkout(1);
    await c.agent.delete(`/api/v1/bookings/${c.bookingId}/hold`);

    await deliver(app, captured(c));

    expect(await stateOf(c.bookingId)).toMatchObject({
      status: 'CANCELLED',
      payments: [{ applied: false, reason: 'HOLD_ENDED' }],
    });
  });

  it('refunds a second payment of the same order', async () => {
    const c = await checkout(1);

    await deliver(app, captured(c));
    await deliver(app, captured(c));

    expect(await stateOf(c.bookingId)).toEqual({
      status: 'CONFIRMED',
      seats: ['BOOKED'],
      payments: [
        { applied: true, reason: null },
        { applied: false, reason: 'DUPLICATE_PAYMENT' },
      ],
    });
  });

  it('applies exactly one of two different payments that arrive at the same moment', async () => {
    const c = await checkout(2);

    await Promise.all([deliver(app, captured(c)), deliver(app, captured(c))]);

    const { status, payments } = await stateOf(c.bookingId);
    expect(status).toBe('CONFIRMED');
    expect(payments.filter((p) => p.applied)).toHaveLength(1);
    expect(payments.filter((p) => p.reason === 'DUPLICATE_PAYMENT')).toHaveLength(1);
  });

  it('refunds a payment for the wrong amount', async () => {
    const c = await checkout(1);

    await deliver(
      app,
      paymentEvent('payment.captured', { orderId: c.orderId, amountPaise: c.amountPaise - 100 }),
    );

    expect(await stateOf(c.bookingId)).toMatchObject({
      status: 'PENDING_PAYMENT',
      payments: [{ applied: false, reason: 'AMOUNT_MISMATCH' }],
    });
  });
});
