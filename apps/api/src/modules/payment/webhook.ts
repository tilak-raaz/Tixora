import { withTransaction, type Logger, type Pool } from '@bmt/platform';
import type { RefundScheduler } from '@bmt/jobs';
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
export function razorpayWebhookRouter(deps: {
  pool: Pool;
  logger: Logger;
  paymentWebhookSecret?: string;
  refunds?: RefundScheduler;
}): Router {
  const router = Router();

  router.post(
    '/webhooks/razorpay',
    express.raw({ type: () => true, limit: '1mb' }),
    async (req, res) => {
      const secret = deps.paymentWebhookSecret;
      if (!secret) {
        throw new AppError(
          503,
          'SERVICE_UNAVAILABLE',
          'Webhooks are not configured on this server',
        );
      }
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const signature = req.get('X-Razorpay-Signature') ?? '';
      if (!verifyWebhookSignature(raw, signature, secret)) {
        throw new AppError(400, 'PAYMENT_SIGNATURE_INVALID', 'The webhook signature is not valid');
      }
      const eventId = req.get('X-Razorpay-Event-Id');
      if (!eventId) {
        throw new AppError(400, 'VALIDATION_FAILED', 'X-Razorpay-Event-Id header is missing');
      }

      let event: RazorpayEvent;
      try {
        event = JSON.parse(raw.toString('utf8')) as RazorpayEvent;
      } catch {
        throw new AppError(400, 'VALIDATION_FAILED', 'The webhook body is not JSON');
      }

      const result = await withTransaction(deps.pool, async (tx) => {
        const { rowCount } = await tx.query(
          `INSERT INTO payment_webhook_events (event_id, event_type, payload)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (event_id) DO NOTHING`,
          [eventId, String(event.event), raw.toString('utf8')],
        );
        if (rowCount === 0) return 'duplicate_event' as const;

        const captured = capturedPaymentFrom(event);
        if (captured) return applyCapturedPayment(tx, captured);

        const refund = refundUpdateFrom(event);
        if (refund) {
          return (await recordRefundState(tx, refund))
            ? ('refund_updated' as const)
            : ('ignored' as const);
        }
        // payment.failed and anything else: stored, nothing to do. The booking
        // stays PENDING_PAYMENT and the buyer can try again until the hold ends.
        return 'ignored' as const;
      });

      // Only after the commit: the refund row must exist before its job runs.
      if (typeof result !== 'string' && result.kind === 'refund') {
        await deps.refunds?.schedule(result.refundId);
      }
      log(deps.logger, eventId, String(event.event), result);
      res.json({ received: true });
    },
  );

  return router;
}

function log(
  logger: Logger,
  eventId: string,
  type: string,
  result: CaptureOutcome | 'duplicate_event' | 'ignored' | 'refund_updated',
): void {
  if (typeof result === 'string') {
    logger.info({ eventId, type, result }, 'razorpay webhook');
  } else if (result.kind === 'refund' || result.kind === 'unknown_order') {
    logger.warn({ eventId, type, ...result }, 'razorpay webhook: payment not applied');
  } else {
    logger.info({ eventId, type, ...result }, 'razorpay webhook');
  }
}
