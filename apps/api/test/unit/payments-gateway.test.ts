import {
  checkoutSignature,
  createRazorpayGateway,
  GatewayError,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  webhookSignature,
} from '@bmt/payments';
import { describe, expect, it } from 'vitest';

/** The Razorpay client against a scripted fetch: what it sends and how it reads answers. */

interface Sent {
  url: string;
  init: RequestInit;
}

function scriptedFetch(status: number, body: unknown) {
  const sent: Sent[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { sent, fakeFetch };
}

const KEYS = { keyId: 'rzp_test_abc', keySecret: 'shh' };
const ORDER = { id: 'order_123', amount: 40_000, currency: 'INR', receipt: 'booking-1' };

describe('razorpay gateway', () => {
  it('creates an order in paise, INR, with the receipt and basic auth', async () => {
    const { sent, fakeFetch } = scriptedFetch(200, ORDER);
    const gateway = createRazorpayGateway({ ...KEYS, fetch: fakeFetch });

    const order = await gateway.createOrder({
      amountPaise: 40_000,
      receipt: 'booking-1',
      notes: { booking_id: 'booking-1' },
    });

    expect(order).toEqual({
      id: 'order_123',
      amountPaise: 40_000,
      currency: 'INR',
      receipt: 'booking-1',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://api.razorpay.com/v1/orders');
    expect(sent[0]!.init.method).toBe('POST');
    const headers = sent[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from('rzp_test_abc:shh').toString('base64')}`,
    );
    expect(JSON.parse(String(sent[0]!.init.body))).toEqual({
      amount: 40_000,
      currency: 'INR',
      receipt: 'booking-1',
      notes: { booking_id: 'booking-1' },
    });
  });

  it('finds an order by receipt, or nothing', async () => {
    const found = scriptedFetch(200, { count: 1, items: [ORDER] });
    expect(
      await createRazorpayGateway({ ...KEYS, fetch: found.fakeFetch }).findOrderByReceipt('b 1'),
    ).toMatchObject({ id: 'order_123' });
    expect(found.sent[0]!.url).toBe('https://api.razorpay.com/v1/orders?receipt=b%201&count=1');

    const none = scriptedFetch(200, { count: 0, items: [] });
    expect(
      await createRazorpayGateway({ ...KEYS, fetch: none.fakeFetch }).findOrderByReceipt('b'),
    ).toBeUndefined();
  });

  it("turns Razorpay's error body into a GatewayError with status and code", async () => {
    const { fakeFetch } = scriptedFetch(400, {
      error: { code: 'BAD_REQUEST_ERROR', description: 'amount must be at least 100' },
    });
    const err = await createRazorpayGateway({ ...KEYS, fetch: fakeFetch })
      .createOrder({ amountPaise: 1, receipt: 'b' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GatewayError);
    expect(err).toMatchObject({
      status: 400,
      code: 'BAD_REQUEST_ERROR',
      message: 'amount must be at least 100',
    });
  });

  it('reports an unreachable Razorpay as a GatewayError without a status', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const err = await createRazorpayGateway({ ...KEYS, fetch: failing })
      .findOrderByReceipt('b')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).status).toBeUndefined();
  });

  it('rejects an answer that is not JSON', async () => {
    const { fakeFetch } = scriptedFetch(200, '<html>maintenance</html>');
    await expect(
      createRazorpayGateway({ ...KEYS, fetch: fakeFetch }).findOrderByReceipt('b'),
    ).rejects.toBeInstanceOf(GatewayError);
  });
});

describe('razorpay gateway: refunds and order payments', () => {
  it('refunds in full with our refund id as the receipt', async () => {
    const { sent, fakeFetch } = scriptedFetch(200, {
      id: 'rfnd_1',
      payment_id: 'pay_1',
      amount: 40_000,
      status: 'pending',
      receipt: 'refund-1',
    });
    const refund = await createRazorpayGateway({ ...KEYS, fetch: fakeFetch }).refundPayment({
      paymentId: 'pay_1',
      amountPaise: 40_000,
      receipt: 'refund-1',
    });

    expect(refund).toEqual({
      id: 'rfnd_1',
      paymentId: 'pay_1',
      amountPaise: 40_000,
      status: 'pending',
      receipt: 'refund-1',
    });
    expect(sent[0]!.url).toBe('https://api.razorpay.com/v1/payments/pay_1/refund');
    expect(JSON.parse(String(sent[0]!.init.body))).toMatchObject({
      amount: 40_000,
      speed: 'normal',
      receipt: 'refund-1',
    });
  });

  it("lists an order's payments with times as dates", async () => {
    const { sent, fakeFetch } = scriptedFetch(200, {
      count: 1,
      items: [
        {
          id: 'pay_1',
          order_id: 'order_1',
          amount: 40_000,
          currency: 'INR',
          status: 'captured',
          created_at: 1_760_000_000,
        },
      ],
    });
    const payments = await createRazorpayGateway({ ...KEYS, fetch: fakeFetch }).listOrderPayments(
      'order_1',
    );

    expect(sent[0]!.url).toBe('https://api.razorpay.com/v1/orders/order_1/payments');
    expect(payments).toEqual([
      {
        id: 'pay_1',
        orderId: 'order_1',
        amountPaise: 40_000,
        currency: 'INR',
        status: 'captured',
        createdAt: new Date(1_760_000_000_000),
      },
    ]);
  });
});

describe('signatures', () => {
  it('accepts the checkout signature for this order and payment only', () => {
    const signature = checkoutSignature('order_1', 'pay_1', 'secret');
    expect(
      verifyCheckoutSignature({ orderId: 'order_1', paymentId: 'pay_1', signature }, 'secret'),
    ).toBe(true);
    expect(
      verifyCheckoutSignature({ orderId: 'order_1', paymentId: 'pay_2', signature }, 'secret'),
    ).toBe(false);
    expect(
      verifyCheckoutSignature({ orderId: 'order_1', paymentId: 'pay_1', signature }, 'other'),
    ).toBe(false);
    expect(
      verifyCheckoutSignature(
        { orderId: 'order_1', paymentId: 'pay_1', signature: 'short' },
        'secret',
      ),
    ).toBe(false);
  });

  it('accepts a webhook signature only for the exact raw body', () => {
    const raw = '{"event":"payment.captured","payload":{}}';
    const signature = webhookSignature(raw, 'whsec');
    expect(verifyWebhookSignature(raw, signature, 'whsec')).toBe(true);
    // Same JSON, different bytes: a re-serialised body must not pass.
    expect(
      verifyWebhookSignature('{"event": "payment.captured", "payload": {}}', signature, 'whsec'),
    ).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(raw), signature, 'whsec')).toBe(true);
  });
});
