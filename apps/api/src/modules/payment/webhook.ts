import {
  NO_SEAT_EVENTS,
  withTransaction,
  type Logger,
  type Pool,
  type SeatEventPublisher,
} from '@bmt/platform';
import {
  applyCapturedPayment,
  capturedPaymentFrom,
  recordRefundState,
  refundUpdateFrom,
  verifyWebhookSignature,
  type CaptureOutcome,
  type RazorpayEvent,
} from '@bmt/payments';
import express, { Router } from 'express';
import { AppError } from '../../lib/errors';

export interface WebhookDeps {
  pool: Pool;
  logger: Logger;
  paymentWebhookSecret?: string;
  seatEvents?: SeatEventPublisher;
}

export type WebhookResult = CaptureOutcome | 'duplicate_event' | 'ignored' | 'refund_updated';

/**
 * Checks and applies one Razorpay webhook delivery. The route below calls it for real deliveries;
 * the fake payment mode calls it with events it signs itself, so a fake payment goes through
 * exactly the same checks and the same confirm-or-refund code as a real one.
 */
export async function handleRazorpayWebhook(
  deps: WebhookDeps,
  delivery: { raw: Buffer; signature: string; eventId: string | undefined; requestId: string },
): Promise<WebhookResult> {
  const secret = deps.paymentWebhookSecret;
  if (!secret) {
    throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Webhooks are not configured on this server');
  }
  const { raw, signature, eventId } = delivery;
  if (!verifyWebhookSignature(raw, signature, secret)) {
    throw new AppError(400, 'PAYMENT_SIGNATURE_INVALID', 'The webhook signature is not valid');
  }
  if (!eventId) {
    throw new AppError(400, 'VALIDATION_FAILED', 'X-Razorpay-Event-Id header is missing');
  }

  let event: RazorpayEvent;
  try {
    event = JSON.parse(raw.toString('utf8')) as RazorpayEvent;
  } catch {
    throw new AppError(400, 'VALIDATION_FAILED', 'The webhook body is not JSON');
  }

  const result = await withTransaction(deps.pool, async (tx): Promise<WebhookResult> => {
    const { rowCount } = await tx.query(
      `INSERT INTO payment_webhook_events (event_id, event_type, payload)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (event_id) DO NOTHING`,
      [eventId, String(event.event), raw.toString('utf8')],
    );
    if (rowCount === 0) return 'duplicate_event';

    const captured = capturedPaymentFrom(event);
    // The request id travels into the outbox event and from there into every job.
    if (captured) return applyCapturedPayment(tx, captured, { requestId: delivery.requestId });

    const refund = refundUpdateFrom(event);
    if (refund) return (await recordRefundState(tx, refund)) ? 'refund_updated' : 'ignored';
    // payment.failed and anything else: stored, nothing to do. The booking
    // stays PENDING_PAYMENT and the buyer can try again until the hold ends.
    return 'ignored';
  });

  // Held seats became booked: still taken to everyone else, but their version moved.
  if (typeof result === 'object' && result.kind === 'confirmed') {
    await (deps.seatEvents ?? NO_SEAT_EVENTS).publishBookings([result.bookingId]);
  }
  log(deps.logger, eventId, String(event.event), result);
  return result;
}

/**
 * POST /webhooks/razorpay. The only path that confirms a booking (besides the
 * reconciler in M3 PR 4): the browser is never trusted with that.
 *
 * 1. Reads the body raw: the signature covers the exact bytes, so it must be
 *    checked before any JSON parsing.
 * 2. Stores the event and acts on it in one transaction. A redelivered event
 *    (same X-Razorpay-Event-Id) finds its row and changes nothing; if acting on
 *    it fails, the event is not stored either, so Razorpay's retry runs it again.
 * 3. Answers 200 for every authentic event, including ones it ignores, so
 *    Razorpay stops retrying them.
 */
export function razorpayWebhookRouter(deps: WebhookDeps): Router {
  const router = Router();

  router.post(
    '/webhooks/razorpay',
    express.raw({ type: () => true, limit: '1mb' }),
    async (req, res) => {
      await handleRazorpayWebhook(deps, {
        raw: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        signature: req.get('X-Razorpay-Signature') ?? '',
        eventId: req.get('X-Razorpay-Event-Id'),
        requestId: String(req.id),
      });
      res.json({ received: true });
    },
  );

  return router;
}

function log(logger: Logger, eventId: string, type: string, result: WebhookResult): void {
  if (typeof result === 'string') {
    logger.info({ eventId, type, result }, 'razorpay webhook');
  } else if (result.kind === 'refund' || result.kind === 'unknown_order') {
    logger.warn({ eventId, type, ...result }, 'razorpay webhook: payment not applied');
  } else {
    logger.info({ eventId, type, ...result }, 'razorpay webhook');
  }
}
