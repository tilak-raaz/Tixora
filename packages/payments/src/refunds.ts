import type { Pool, PoolClient } from '@bmt/platform';
import { GatewayError, type GatewayRefund, type PaymentGateway } from './gateway';

/**
 * Sending recorded refunds to Razorpay, and recording what Razorpay says about
 * them. A refund row is written in the same transaction that decides a payment
 * cannot be applied (capture.ts); from then on it is only ever moved forward
 * here: PENDING, then PROCESSED or FAILED.
 *
 * Razorpay is never called inside a transaction. Sending is safe to repeat:
 * our refund id is the Razorpay receipt, Razorpay refuses a second refund with
 * the same receipt, and a retry then finds the first one instead.
 */

export type RefundResult = 'processed' | 'pending' | 'failed' | 'not_pending';

const STATUS: Record<GatewayRefund['status'], 'PENDING' | 'PROCESSED' | 'FAILED'> = {
  pending: 'PENDING',
  processed: 'PROCESSED',
  failed: 'FAILED',
};

/**
 * Makes sure Razorpay has this refund, and records its state. Throws a
 * GatewayError when Razorpay cannot be reached, so the job retries.
 */
export async function sendRefund(
  pool: Pool,
  gateway: PaymentGateway,
  refundId: string,
): Promise<RefundResult> {
  const { rows } = await pool.query<{
    status: string;
    razorpayRefundId: string | null;
    amountPaise: number;
    razorpayPaymentId: string;
  }>(
    `SELECT r.status, r.razorpay_refund_id AS "razorpayRefundId", r.amount_paise AS "amountPaise",
            p.razorpay_payment_id AS "razorpayPaymentId"
     FROM refunds r JOIN payments p ON p.id = r.payment_id
     WHERE r.id = $1`,
    [refundId],
  );
  const refund = rows[0];
  if (!refund || refund.status !== 'PENDING') return 'not_pending';

  let atRazorpay: GatewayRefund | undefined;
  if (refund.razorpayRefundId) {
    // Already sent; Razorpay said pending. Ask how it went.
    atRazorpay = await findAtRazorpay(
      gateway,
      refund.razorpayPaymentId,
      refundId,
      refund.razorpayRefundId,
    );
  } else {
    try {
      atRazorpay = await gateway.refundPayment({
        paymentId: refund.razorpayPaymentId,
        amountPaise: refund.amountPaise,
        receipt: refundId,
      });
    } catch (err) {
      // Refused (receipt already used, or already refunded): an earlier attempt
      // got through before we could record it. Find that refund.
      if (!(err instanceof GatewayError) || err.status !== 400) throw err;
      atRazorpay = await findAtRazorpay(gateway, refund.razorpayPaymentId, refundId);
      if (!atRazorpay) throw err;
    }
  }
  if (!atRazorpay) {
    throw new GatewayError(`Razorpay has no refund with receipt ${refundId}`);
  }

  await recordRefundState(pool, {
    refundId,
    razorpayRefundId: atRazorpay.id,
    status: atRazorpay.status,
  });
  return atRazorpay.status;
}

async function findAtRazorpay(
  gateway: PaymentGateway,
  paymentId: string,
  receipt: string,
  razorpayRefundId?: string,
): Promise<GatewayRefund | undefined> {
  return (await gateway.listRefunds(paymentId)).find(
    (r) => r.receipt === receipt || (razorpayRefundId !== undefined && r.id === razorpayRefundId),
  );
}

/**
 * Moves a PENDING refund forward. Matches by our id or Razorpay's, whichever
 * the caller knows: a refund.processed webhook can arrive before the job has
 * stored Razorpay's id. A refund already PROCESSED or FAILED is never changed.
 */
export async function recordRefundState(
  db: Pool | PoolClient,
  update: { refundId?: string; razorpayRefundId: string; status: GatewayRefund['status'] },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE refunds
     SET razorpay_refund_id = COALESCE(razorpay_refund_id, $2),
         status = $3,
         processed_at = CASE WHEN $3 = 'PROCESSED' THEN now() END
     WHERE status = 'PENDING'
       AND (razorpay_refund_id = $2 OR id::text = $1)`,
    [update.refundId ?? '', update.razorpayRefundId, STATUS[update.status]],
  );
  return rowCount === 1;
}

/** Refunds Razorpay has not finished, for the sweeper: oldest first. */
export async function findPendingRefunds(
  db: Pool | PoolClient,
  opts: { olderThanSeconds: number; limit: number },
): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM refunds
     WHERE status = 'PENDING' AND updated_at <= now() - make_interval(secs => $1)
     ORDER BY created_at
     LIMIT $2`,
    [opts.olderThanSeconds, opts.limit],
  );
  return rows.map((r) => r.id);
}
