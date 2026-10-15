import type { CapturedPayment } from './capture';
import type { GatewayRefundStatus } from './gateway';

/**
 * The parts of a Razorpay webhook event the app reads. Everything else is kept
 * in payment_webhook_events.payload as received.
 */
export interface RazorpayEvent {
  event: string;
  created_at?: number;
  payload?: {
    payment?: {
      entity?: {
        id?: string;
        amount?: number;
        currency?: string;
        status?: string;
        order_id?: string | null;
      };
    };
    refund?: {
      entity?: {
        id?: string;
        payment_id?: string;
        status?: string;
        receipt?: string | null;
      };
    };
  };
}

/** Events that report a captured payment. order.paid repeats payment.captured; both are handled the same. */
export const CAPTURE_EVENTS = new Set(['payment.captured', 'order.paid']);

/** The captured payment an event reports, or undefined if it reports none. */
export function capturedPaymentFrom(event: RazorpayEvent): CapturedPayment | undefined {
  if (!CAPTURE_EVENTS.has(event.event)) return undefined;
  const p = event.payload?.payment?.entity;
  if (!p?.id || !p.order_id || typeof p.amount !== 'number' || !p.currency) return undefined;
  if (p.status !== 'captured') return undefined;
  return {
    razorpayPaymentId: p.id,
    razorpayOrderId: p.order_id,
    amountPaise: p.amount,
    currency: p.currency,
    // The event is created when the payment is captured.
    capturedAt: new Date((event.created_at ?? Date.now() / 1000) * 1000),
  };
}

export interface RefundUpdate {
  razorpayRefundId: string;
  /** Our refund id, sent to Razorpay as the receipt. */
  refundId?: string;
  status: GatewayRefundStatus;
}

/** What a refund.processed or refund.failed event says, or undefined for any other event. */
export function refundUpdateFrom(event: RazorpayEvent): RefundUpdate | undefined {
  const status =
    event.event === 'refund.processed'
      ? 'processed'
      : event.event === 'refund.failed'
        ? 'failed'
        : undefined;
  const r = event.payload?.refund?.entity;
  if (!status || !r?.id) return undefined;
  return { razorpayRefundId: r.id, refundId: r.receipt ?? undefined, status };
}
