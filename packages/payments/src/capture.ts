import { writeOutbox, type PoolClient } from '@bmt/platform';

/**
 * Applying a payment Razorpay has captured. The webhook calls this, and from
 * M3 PR 4 so does the reconciler (for webhooks that never arrive), so both
 * paths share one set of rules:
 *
 * - A payment is recorded once, by its Razorpay id: a redelivered webhook, or
 *   the same payment reported by both payment.captured and order.paid, finds
 *   its row and changes nothing.
 * - Whatever it decides is announced in the outbox, in the same transaction:
 *   booking.confirmed, or refund.recorded (ADR 0008).
 * - It confirms the booking only while the hold is still active and every one
 *   of the booking's seats is still held by it. Anything else is refunded in
 *   full: a payment after the hold ended, a second payment of the same order,
 *   or an amount that does not match. A late payment never overrides an expiry.
 * - The booking row is locked first. Hold expiry, releasing a hold and every
 *   capture lock it too, so they happen one at a time and the first one wins.
 */

export interface CapturedPayment {
  razorpayPaymentId: string;
  razorpayOrderId: string;
  amountPaise: number;
  currency: string;
  capturedAt: Date;
}

export type RefundReason = 'HOLD_ENDED' | 'DUPLICATE_PAYMENT' | 'AMOUNT_MISMATCH';

export type CaptureOutcome =
  | { kind: 'confirmed'; bookingId: string; paymentId: string }
  | { kind: 'refund'; bookingId: string; paymentId: string; refundId: string; reason: RefundReason }
  /** This payment was already applied; nothing changed. */
  | { kind: 'already_recorded'; bookingId: string }
  /** Not an order this app created (another integration on the same account); ignored. */
  | { kind: 'unknown_order' };

/**
 * Must run inside the caller's transaction; the outcome, and the outbox event
 * announcing it, commit or roll back with it.
 */
export async function applyCapturedPayment(
  tx: PoolClient,
  payment: CapturedPayment,
  context: { requestId?: string } = {},
): Promise<CaptureOutcome> {
  const { rows: orders } = await tx.query<{ id: string; bookingId: string; amountPaise: number }>(
    `SELECT id, booking_id AS "bookingId", amount_paise AS "amountPaise"
     FROM payment_orders WHERE razorpay_order_id = $1`,
    [payment.razorpayOrderId],
  );
  const order = orders[0];
  if (!order) return { kind: 'unknown_order' };
  const { bookingId } = order;

  const { rows: bookings } = await tx.query<{ status: string; active: boolean }>(
    `SELECT status, expires_at > now() AS active FROM bookings WHERE id = $1 FOR NO KEY UPDATE`,
    [bookingId],
  );
  const booking = bookings[0]!;

  const { rows: inserted } = await tx.query<{ id: string }>(
    `INSERT INTO payments (order_id, razorpay_payment_id, amount_paise, captured_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (razorpay_payment_id) DO NOTHING
     RETURNING id`,
    [order.id, payment.razorpayPaymentId, payment.amountPaise, payment.capturedAt],
  );
  const paymentId = inserted[0]?.id;
  if (!paymentId) return { kind: 'already_recorded', bookingId };

  const refund = async (reason: RefundReason): Promise<CaptureOutcome> => {
    const { rows } = await tx.query<{ id: string }>(
      'INSERT INTO refunds (payment_id, amount_paise, reason) VALUES ($1, $2, $3) RETURNING id',
      [paymentId, payment.amountPaise, reason],
    );
    const refundId = rows[0]!.id;
    // The relay turns this into the refund job (sent to Razorpay) and the email.
    await writeOutbox(
      tx,
      'refund.recorded',
      { refundId, bookingId, reason },
      { aggregateId: refundId, requestId: context.requestId },
    );
    return { kind: 'refund', bookingId, paymentId, refundId, reason };
  };

  if (payment.amountPaise !== order.amountPaise || payment.currency !== 'INR') {
    return refund('AMOUNT_MISMATCH');
  }
  if (booking.status === 'CONFIRMED') return refund('DUPLICATE_PAYMENT');
  if (booking.status !== 'PENDING_PAYMENT' || !booking.active) return refund('HOLD_ENDED');

  // Lock the seats (in id order, like every hold) and check each one is still ours.
  const { rows: seats } = await tx.query<{ ours: boolean }>(
    `SELECT ss.status = 'HELD' AND ss.booking_id = $1 AS ours
     FROM booking_seats bs JOIN show_seats ss ON ss.id = bs.show_seat_id
     WHERE bs.booking_id = $1
     ORDER BY ss.id
     FOR NO KEY UPDATE OF ss`,
    [bookingId],
  );
  if (seats.length === 0 || !seats.every((s) => s.ours)) return refund('HOLD_ENDED');

  await tx.query(
    `UPDATE show_seats SET status = 'BOOKED', held_until = NULL, version = version + 1
     WHERE booking_id = $1 AND status = 'HELD'`,
    [bookingId],
  );
  await tx.query("UPDATE bookings SET status = 'CONFIRMED', confirmed_at = now() WHERE id = $1", [
    bookingId,
  ]);
  await tx.query('UPDATE payments SET applied = true WHERE id = $1', [paymentId]);
  await writeOutbox(
    tx,
    'booking.confirmed',
    { bookingId },
    { aggregateId: bookingId, requestId: context.requestId },
  );
  return { kind: 'confirmed', bookingId, paymentId };
}
