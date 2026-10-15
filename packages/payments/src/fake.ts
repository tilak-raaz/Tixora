import { randomUUID } from 'node:crypto';
import {
  GatewayError,
  type CreateOrderInput,
  type GatewayOrder,
  type PaymentGateway,
} from './gateway';
import { checkoutSignature, verifyCheckoutSignature } from './signatures';

export const FAKE_KEY_ID = 'rzp_test_fake';
export const FAKE_KEY_SECRET = 'fake_key_secret';

export interface FakeGateway extends PaymentGateway {
  /** Every order "Razorpay" holds, including orphans from racing requests. */
  readonly orders: GatewayOrder[];
  readonly calls: { createOrder: number; findOrderByReceipt: number };
  /** The next gateway call fails as if Razorpay were down. */
  failNext(): void;
  /** What Checkout would hand the browser after a successful payment. */
  checkoutSuccess(orderId: string): { paymentId: string; signature: string };
}

/** An in-memory Razorpay with the same interface, for tests. */
export function createFakeGateway(): FakeGateway {
  const orders: GatewayOrder[] = [];
  const calls = { createOrder: 0, findOrderByReceipt: 0 };
  let failing = false;

  async function maybeFail(): Promise<void> {
    // Real calls are asynchronous; a tick lets concurrent requests interleave as they would.
    await new Promise((resolve) => setImmediate(resolve));
    if (failing) {
      failing = false;
      throw new GatewayError('Razorpay unreachable: fake outage');
    }
  }

  return {
    keyId: FAKE_KEY_ID,
    orders,
    calls,

    async createOrder({ amountPaise, receipt }: CreateOrderInput): Promise<GatewayOrder> {
      calls.createOrder += 1;
      await maybeFail();
      const order: GatewayOrder = {
        id: `order_${randomUUID().replaceAll('-', '').slice(0, 14)}`,
        amountPaise,
        currency: 'INR',
        receipt,
      };
      orders.push(order);
      return { ...order };
    },

    async findOrderByReceipt(receipt: string): Promise<GatewayOrder | undefined> {
      calls.findOrderByReceipt += 1;
      await maybeFail();
      const order = orders.find((o) => o.receipt === receipt);
      return order ? { ...order } : undefined;
    },

    verifyCheckoutSignature(input) {
      return verifyCheckoutSignature(input, FAKE_KEY_SECRET);
    },

    failNext() {
      failing = true;
    },

    checkoutSuccess(orderId: string) {
      const paymentId = `pay_${randomUUID().replaceAll('-', '').slice(0, 14)}`;
      return { paymentId, signature: checkoutSignature(orderId, paymentId, FAKE_KEY_SECRET) };
    },
  };
}
