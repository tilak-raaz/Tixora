import { randomUUID } from 'node:crypto';
import {
  GatewayError,
  type CreateOrderInput,
  type GatewayOrder,
  type GatewayPayment,
  type GatewayRefund,
  type GatewayRefundStatus,
  type PaymentGateway,
  type RefundInput,
} from './gateway';
import { checkoutSignature, verifyCheckoutSignature } from './signatures';

export const FAKE_KEY_ID = 'rzp_test_fake';
export const FAKE_KEY_SECRET = 'fake_key_secret';

export interface FakeGateway extends PaymentGateway {
  /** Every order "Razorpay" holds, including orphans from racing requests. */
  readonly orders: GatewayOrder[];
  readonly payments: GatewayPayment[];
  readonly refunds: GatewayRefund[];
  readonly calls: {
    createOrder: number;
    findOrderByReceipt: number;
    listOrderPayments: number;
    refundPayment: number;
    listRefunds: number;
  };
  /** The next gateway call fails as if Razorpay were down. */
  failNext(): void;
  /** Status new refunds come back with (Razorpay answers pending or processed). */
  refundStatus: GatewayRefundStatus;
  /** What Checkout would hand the browser after a successful payment. */
  checkoutSuccess(orderId: string): { paymentId: string; signature: string };
  /** A buyer pays an order (captured), without any webhook being sent. */
  capture(orderId: string, amountPaise?: number): GatewayPayment;
  /** Razorpay finishes a pending refund. */
  settleRefund(refundId: string, status: GatewayRefundStatus): void;
}

const fakeId = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 14)}`;

/** An in-memory Razorpay with the same interface, for tests. */
export function createFakeGateway(): FakeGateway {
  const orders: GatewayOrder[] = [];
  const payments: GatewayPayment[] = [];
  const refunds: GatewayRefund[] = [];
  const calls = {
    createOrder: 0,
    findOrderByReceipt: 0,
    listOrderPayments: 0,
    refundPayment: 0,
    listRefunds: 0,
  };
  let failing = false;

  async function maybeFail(): Promise<void> {
    // Real calls are asynchronous; a tick lets concurrent requests interleave as they would.
    await new Promise((resolve) => setImmediate(resolve));
    if (failing) {
      failing = false;
      throw new GatewayError('Razorpay unreachable: fake outage');
    }
  }

  const gateway: FakeGateway = {
    keyId: FAKE_KEY_ID,
    orders,
    payments,
    refunds,
    calls,
    refundStatus: 'processed',

    async createOrder({ amountPaise, receipt }: CreateOrderInput): Promise<GatewayOrder> {
      calls.createOrder += 1;
      await maybeFail();
      const order: GatewayOrder = { id: fakeId('order'), amountPaise, currency: 'INR', receipt };
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

    async listOrderPayments(orderId: string): Promise<GatewayPayment[]> {
      calls.listOrderPayments += 1;
      await maybeFail();
      return payments.filter((p) => p.orderId === orderId).map((p) => ({ ...p }));
    },

    async refundPayment({ paymentId, amountPaise, receipt }: RefundInput): Promise<GatewayRefund> {
      calls.refundPayment += 1;
      await maybeFail();
      // Like Razorpay: a receipt already used on this payment is refused, not repeated.
      if (refunds.some((r) => r.paymentId === paymentId && r.receipt === receipt)) {
        throw new GatewayError('A refund with this receipt already exists', {
          status: 400,
          code: 'BAD_REQUEST_ERROR',
        });
      }
      const refunded = refunds
        .filter((r) => r.paymentId === paymentId && r.status !== 'failed')
        .reduce((sum, r) => sum + r.amountPaise, 0);
      const payment = payments.find((p) => p.id === paymentId);
      if (payment && refunded + amountPaise > payment.amountPaise) {
        throw new GatewayError('The payment has been fully refunded already', {
          status: 400,
          code: 'BAD_REQUEST_ERROR',
        });
      }
      const refund: GatewayRefund = {
        id: fakeId('rfnd'),
        paymentId,
        amountPaise,
        status: gateway.refundStatus,
        receipt,
      };
      refunds.push(refund);
      return { ...refund };
    },

    async listRefunds(paymentId: string): Promise<GatewayRefund[]> {
      calls.listRefunds += 1;
      await maybeFail();
      return refunds.filter((r) => r.paymentId === paymentId).map((r) => ({ ...r }));
    },

    failNext() {
      failing = true;
    },

    checkoutSuccess(orderId: string) {
      const paymentId = fakeId('pay');
      return { paymentId, signature: checkoutSignature(orderId, paymentId, FAKE_KEY_SECRET) };
    },

    capture(orderId: string, amountPaise?: number): GatewayPayment {
      const order = orders.find((o) => o.id === orderId);
      const payment: GatewayPayment = {
        id: fakeId('pay'),
        orderId,
        amountPaise: amountPaise ?? order?.amountPaise ?? 0,
        currency: 'INR',
        status: 'captured',
        createdAt: new Date(),
      };
      payments.push(payment);
      return { ...payment };
    },

    settleRefund(refundId: string, status: GatewayRefundStatus) {
      const refund = refunds.find((r) => r.id === refundId);
      if (refund) refund.status = status;
    },
  };
  return gateway;
}
