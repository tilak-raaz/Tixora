import type { CapturedPayment } from './capture';

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
