import { randomUUID } from 'node:crypto';
import type { Pool } from '@bmt/platform';
import type { Express } from 'express';
import { expect } from 'vitest';
import { createShowFixture } from './fixtures';
import { signInAsUser, type Agent } from './sessions';

export interface Checkout {
  agent: Agent;
  showId: string;
  seatIds: string[];
  bookingId: string;
  orderId: string;
  amountPaise: number;
}

/** A buyer who has held `seats` seats (₹200 each) and opened Checkout for them. */
export async function createCheckout(app: Express, pool: Pool, seats = 1): Promise<Checkout> {
  const agent = await signInAsUser(app);
  const { showId, seatIds } = await createShowFixture(pool, seats);
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

/** Moves a hold 10 minutes into the past. */
export async function expireHoldNow(pool: Pool, bookingId: string): Promise<void> {
  await pool.query(
    `UPDATE bookings SET created_at = now() - interval '10 minutes',
                         expires_at = now() - interval '1 minute' WHERE id = $1`,
    [bookingId],
  );
  await pool.query(
    "UPDATE show_seats SET held_until = now() - interval '1 minute' WHERE booking_id = $1",
    [bookingId],
  );
}

export async function bookingStatus(pool: Pool, bookingId: string): Promise<string> {
  const { rows } = await pool.query<{ status: string }>(
    'SELECT status FROM bookings WHERE id = $1',
    [bookingId],
  );
  return rows[0]!.status;
}

export interface RefundRow {
  id: string;
  status: string;
  reason: string;
  razorpayRefundId: string | null;
}

export async function refundsOf(pool: Pool, bookingId: string): Promise<RefundRow[]> {
  const { rows } = await pool.query<RefundRow>(
    `SELECT r.id, r.status, r.reason, r.razorpay_refund_id AS "razorpayRefundId"
     FROM refunds r
     JOIN payments p ON p.id = r.payment_id
     JOIN payment_orders po ON po.id = p.order_id
     WHERE po.booking_id = $1
     ORDER BY r.created_at`,
    [bookingId],
  );
  return rows;
}
