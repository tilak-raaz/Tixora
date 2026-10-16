import { randomUUID } from 'node:crypto';
import {
  checkoutSignature,
  FAKE_KEY_SECRET,
  webhookSignature,
  type FakeGateway,
} from '@bmt/payments';
import { Router } from 'express';
import { z } from 'zod';
import { AppError, NotFoundError } from '../../lib/errors';
import { parseBody, parseParams } from '../../lib/validate';
import type { Auth } from '../auth/auth';
import { requireAuth } from '../auth/middleware';
import { findBookingView } from '../booking/repo';
import { bookingIdParam } from '../booking/schemas';
import * as repo from './repo';
import { handleRazorpayWebhook, type WebhookDeps } from './webhook';

const fakePaymentSchema = z.object({ outcome: z.enum(['paid', 'failed']) });

/** A Razorpay webhook event for one payment of an order, as Razorpay would send it. */
function paymentEvent(
  type: 'payment.captured' | 'payment.failed',
  payment: { id: string; orderId: string; amountPaise: number },
) {
  return {
    entity: 'event',
    account_id: 'acc_fake',
    event: type,
    contains: ['payment'],
    created_at: Math.floor(Date.now() / 1000),
    payload: {
      payment: {
        entity: {
          id: payment.id,
          entity: 'payment',
          amount: payment.amountPaise,
          currency: 'INR',
          status: type === 'payment.captured' ? 'captured' : 'failed',
          order_id: payment.orderId,
          captured: type === 'payment.captured',
        },
      },
    },
  };
}

/**
 * POST /api/v1/dev/fake-payments/:id, mounted only when PAYMENT_GATEWAY=fake (never in production).
 * It plays both Razorpay parts of a payment, so the web app and the end-to-end tests can pay
 * without Razorpay:
 *
 * - Checkout: answers like Razorpay Checkout's success callback (order id, payment id, signature),
 *   which the browser then sends to /payment/verify as usual.
 * - The webhook: a signed payment.captured (or payment.failed) event, applied through the same
 *   handler as real webhooks, `webhookDelayMs` later, the way the real one arrives after Checkout
 *   closes. So the booking is still confirmed by the webhook, never by the browser.
 */
export function fakeCheckoutRouter(
  deps: WebhookDeps & {
    auth: Auth;
    fakeGateway: FakeGateway;
    paymentWebhookSecret: string;
    /** 0 applies the webhook before answering (tests). */
    webhookDelayMs?: number;
  },
): Router {
  const router = Router();
  const delayMs = deps.webhookDelayMs ?? 1_500;

  async function deliver(event: object): Promise<void> {
    const raw = Buffer.from(JSON.stringify(event));
    await handleRazorpayWebhook(deps, {
      raw,
      signature: webhookSignature(raw, deps.paymentWebhookSecret),
      eventId: `evt_fake_${randomUUID()}`,
      requestId: `fake-${randomUUID()}`,
    });
  }

  router.post('/fake-payments/:id', requireAuth(deps.auth), async (req, res) => {
    const { id } = parseParams(bookingIdParam, req);
    const { outcome } = parseBody(fakePaymentSchema, req);
    if (!(await findBookingView(deps.pool, id, req.auth!.user.id))) {
      throw new NotFoundError('Booking not found');
    }
    const order = await repo.findOrder(deps.pool, id);
    if (!order) {
      throw new AppError(409, 'CONFLICT', 'Create the payment order before paying');
    }

    const payment =
      outcome === 'paid'
        ? deps.fakeGateway.capture(order.razorpayOrderId)
        : { id: `pay_fake_${randomUUID().slice(0, 8)}`, orderId: order.razorpayOrderId };
    const event = paymentEvent(outcome === 'paid' ? 'payment.captured' : 'payment.failed', {
      id: payment.id,
      orderId: order.razorpayOrderId,
      amountPaise: order.amountPaise,
    });

    if (delayMs === 0) {
      await deliver(event);
    } else {
      setTimeout(() => {
        deliver(event).catch((err: unknown) => {
          deps.logger.error({ err, bookingId: id }, 'fake payment webhook failed');
        });
      }, delayMs).unref();
    }

    if (outcome === 'failed') {
      res.json({ failed: true });
      return;
    }
    res.json({
      razorpayOrderId: order.razorpayOrderId,
      razorpayPaymentId: payment.id,
      razorpaySignature: checkoutSignature(order.razorpayOrderId, payment.id, FAKE_KEY_SECRET),
    });
  });

  return router;
}
