import {
  GatewayError,
  type CheckoutSignatureInput,
  type CreateOrderInput,
  type GatewayOrder,
  type GatewayPayment,
  type GatewayRefund,
  type PaymentGateway,
  type RefundInput,
} from './gateway';
import { verifyCheckoutSignature } from './signatures';

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  baseUrl?: string;
  /** Per request; Razorpay is called outside any transaction, but a request still must not hang. */
  timeoutMs?: number;
  /** Injected in unit tests. */
  fetch?: typeof fetch;
}

interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  receipt: string | null;
}

interface RazorpayPayment {
  id: string;
  order_id: string | null;
  amount: number;
  currency: string;
  status: string;
  created_at: number;
}

interface RazorpayRefund {
  id: string;
  payment_id: string;
  amount: number;
  status: GatewayRefund['status'];
  receipt: string | null;
}

interface RazorpayErrorBody {
  error?: { code?: string; description?: string };
}

/** Razorpay's REST API over fetch: a few endpoints, no SDK. */
export function createRazorpayGateway(config: RazorpayConfig): PaymentGateway {
  const baseUrl = config.baseUrl ?? 'https://api.razorpay.com/v1';
  const timeoutMs = config.timeoutMs ?? 10_000;
  const doFetch = config.fetch ?? fetch;
  const authorization = `Basic ${Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64')}`;

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new GatewayError(`Razorpay unreachable: ${(err as Error).message}`, { cause: err });
    }

    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const error = (json as RazorpayErrorBody | undefined)?.error;
      throw new GatewayError(error?.description ?? `Razorpay answered ${res.status}`, {
        status: res.status,
        code: error?.code,
      });
    }
    if (json === undefined) {
      throw new GatewayError('Razorpay answered with a body that is not JSON', {
        status: res.status,
      });
    }
    return json as T;
  }

  return {
    keyId: config.keyId,

    async createOrder({ amountPaise, receipt, notes }: CreateOrderInput): Promise<GatewayOrder> {
      const order = await call<RazorpayOrder>('POST', '/orders', {
        amount: amountPaise,
        currency: 'INR',
        receipt,
        notes,
      });
      return toOrder(order);
    },

    async findOrderByReceipt(receipt: string): Promise<GatewayOrder | undefined> {
      const list = await call<{ items: RazorpayOrder[] }>(
        'GET',
        `/orders?receipt=${encodeURIComponent(receipt)}&count=1`,
      );
      const order = list.items[0];
      return order ? toOrder(order) : undefined;
    },

    verifyCheckoutSignature(input: CheckoutSignatureInput): boolean {
      return verifyCheckoutSignature(input, config.keySecret);
    },

    async listOrderPayments(orderId: string): Promise<GatewayPayment[]> {
      const list = await call<{ items: RazorpayPayment[] }>(
        'GET',
        `/orders/${encodeURIComponent(orderId)}/payments`,
      );
      return list.items.map((p) => ({
        id: p.id,
        orderId: p.order_id,
        amountPaise: p.amount,
        currency: p.currency,
        status: p.status,
        createdAt: new Date(p.created_at * 1000),
      }));
    },

    async refundPayment({ paymentId, amountPaise, receipt }: RefundInput): Promise<GatewayRefund> {
      const refund = await call<RazorpayRefund>(
        'POST',
        `/payments/${encodeURIComponent(paymentId)}/refund`,
        { amount: amountPaise, speed: 'normal', receipt, notes: { refund_id: receipt } },
      );
      return toRefund(refund);
    },

    async listRefunds(paymentId: string): Promise<GatewayRefund[]> {
      const list = await call<{ items: RazorpayRefund[] }>(
        'GET',
        `/payments/${encodeURIComponent(paymentId)}/refunds?count=100`,
      );
      return list.items.map(toRefund);
    },
  };
}

function toRefund(refund: RazorpayRefund): GatewayRefund {
  return {
    id: refund.id,
    paymentId: refund.payment_id,
    amountPaise: refund.amount,
    status: refund.status,
    receipt: refund.receipt,
  };
}

function toOrder(order: RazorpayOrder): GatewayOrder {
  return {
    id: order.id,
    amountPaise: order.amount,
    currency: order.currency,
    receipt: order.receipt,
  };
}
