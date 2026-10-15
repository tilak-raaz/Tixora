import { randomUUID } from 'node:crypto';
import { webhookSignature } from '@bmt/payments';
import type { Express } from 'express';
import request from 'supertest';

export const WEBHOOK_SECRET = 'test-webhook-secret';

/** A Razorpay event as it arrives, for the captured or failed payment `paymentId` of `orderId`. */
export function paymentEvent(
  type: 'payment.captured' | 'order.paid' | 'payment.failed',
  payment: { orderId: string; paymentId?: string; amountPaise: number; currency?: string },
) {
  return {
    entity: 'event',
    account_id: 'acc_test',
    event: type,
    contains: type === 'order.paid' ? ['payment', 'order'] : ['payment'],
    created_at: Math.floor(Date.now() / 1000),
    payload: {
      payment: {
        entity: {
          id: payment.paymentId ?? `pay_${randomUUID().replaceAll('-', '').slice(0, 14)}`,
          entity: 'payment',
          amount: payment.amountPaise,
          currency: payment.currency ?? 'INR',
          status: type === 'payment.failed' ? 'failed' : 'captured',
          order_id: payment.orderId,
          captured: type !== 'payment.failed',
        },
      },
    },
  };
}

/** Delivers an event the way Razorpay does: raw JSON, signed, with an event id. */
export function deliver(
  app: Express,
  event: object,
  opts: { eventId?: string; secret?: string; signature?: string } = {},
) {
  const raw = JSON.stringify(event);
  return request(app)
    .post('/webhooks/razorpay')
    .set('Content-Type', 'application/json')
    .set('X-Razorpay-Event-Id', opts.eventId ?? `evt_${randomUUID()}`)
    .set(
      'X-Razorpay-Signature',
      opts.signature ?? webhookSignature(raw, opts.secret ?? WEBHOOK_SECRET),
    )
    .send(raw);
}
