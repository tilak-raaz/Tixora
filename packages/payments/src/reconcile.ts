import { withTransaction, type Pool } from '@bmt/platform';
import { applyCapturedPayment, type CaptureOutcome } from './capture';
import type { PaymentGateway } from './gateway';

/**
 * The reconciler: for webhooks that never arrive. It asks Razorpay about
 * recent orders whose booking is not confirmed, and applies every captured
 * payment it finds through the same code as the webhook (capture.ts), so a
 * payment reported by both is still applied once.
 *
 * Claiming an order and asking Razorpay are separate steps: a short UPDATE
 * stamps checked_at (SKIP LOCKED, so several workers split the orders and
 * never check one twice), then Razorpay is called with no transaction open.
 */

export interface ReconcileOptions {
  /** Leave the webhook this long to arrive before asking Razorpay. */
  minAgeSeconds: number;
  /** Stop looking at an order after this long; Razorpay auto-refunds uncaptured payments. */
  maxAgeSeconds: number;
  /** Check each order at most this often. */
  recheckSeconds: number;
  batchSize: number;
}

export const DEFAULT_RECONCILE_OPTIONS: ReconcileOptions = {
  minAgeSeconds: 60,
  maxAgeSeconds: 24 * 60 * 60,
  recheckSeconds: 10 * 60,
  batchSize: 50,
};

export interface ReconcileReport {
  checked: number;
  outcomes: CaptureOutcome[];
  /** Orders Razorpay could not be asked about this time; they come round again. */
  failed: number;
}

export async function claimOrdersToCheck(pool: Pool, opts: ReconcileOptions): Promise<string[]> {
  const { rows } = await pool.query<{ razorpayOrderId: string }>(
    `UPDATE payment_orders SET checked_at = now()
     WHERE id IN (
       SELECT po.id FROM payment_orders po JOIN bookings b ON b.id = po.booking_id
       WHERE b.status <> 'CONFIRMED'
         AND po.created_at <= now() - make_interval(secs => $1)
         AND po.created_at > now() - make_interval(secs => $2)
         AND (po.checked_at IS NULL OR po.checked_at <= now() - make_interval(secs => $3))
       ORDER BY po.checked_at NULLS FIRST, po.created_at
       LIMIT $4
       FOR UPDATE OF po SKIP LOCKED
     )
     RETURNING razorpay_order_id AS "razorpayOrderId"`,
    [opts.minAgeSeconds, opts.maxAgeSeconds, opts.recheckSeconds, opts.batchSize],
  );
  return rows.map((r) => r.razorpayOrderId);
}

/** One pass: claim a batch, ask Razorpay about each order, apply what was captured. */
export async function reconcileOnce(
  pool: Pool,
  gateway: PaymentGateway,
  opts: ReconcileOptions = DEFAULT_RECONCILE_OPTIONS,
): Promise<ReconcileReport> {
  const orderIds = await claimOrdersToCheck(pool, opts);
  const report: ReconcileReport = { checked: orderIds.length, outcomes: [], failed: 0 };

  for (const orderId of orderIds) {
    let payments;
    try {
      payments = await gateway.listOrderPayments(orderId);
    } catch {
      report.failed += 1;
      continue;
    }
    for (const p of payments) {
      // Only captured money is applied; anything else (authorized, failed, or a
      // payment refunded by hand in the Dashboard) is not ours to act on.
      if (p.status !== 'captured') continue;
      const outcome = await withTransaction(pool, (tx) =>
        applyCapturedPayment(tx, {
          razorpayPaymentId: p.id,
          razorpayOrderId: orderId,
          amountPaise: p.amountPaise,
          currency: p.currency,
          capturedAt: p.createdAt,
        }),
      );
      if (outcome.kind !== 'already_recorded') report.outcomes.push(outcome);
    }
  }
  return report;
}
