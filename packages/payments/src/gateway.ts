/**
 * What the app needs from a payment provider. Razorpay implements it for real
 * (razorpay.ts); an in-memory fake implements it for tests (fake.ts), so no
 * test ever calls Razorpay.
 */

export interface GatewayOrder {
  /** Razorpay's id, e.g. order_P9x2... */
  id: string;
  amountPaise: number;
  currency: string;
  receipt: string | null;
}

export interface CreateOrderInput {
  amountPaise: number;
  /** Our idempotency key at Razorpay: the booking id (at most 40 characters). */
  receipt: string;
  notes?: Record<string, string>;
}

export interface CheckoutSignatureInput {
  orderId: string;
  paymentId: string;
  signature: string;
}

export interface GatewayPayment {
  id: string;
  orderId: string | null;
  amountPaise: number;
  currency: string;
  /** created, authorized, captured, refunded or failed. Only captured money is ours to apply. */
  status: string;
  createdAt: Date;
}

export type GatewayRefundStatus = 'pending' | 'processed' | 'failed';

export interface GatewayRefund {
  id: string;
  paymentId: string;
  amountPaise: number;
  status: GatewayRefundStatus;
  receipt: string | null;
}

export interface RefundInput {
  paymentId: string;
  amountPaise: number;
  /** Our refund id: Razorpay refuses a second refund with the same receipt. */
  receipt: string;
}

export interface PaymentGateway {
  /** The public key id; the browser's checkout needs it, so it is not a secret. */
  readonly keyId: string;
  createOrder(input: CreateOrderInput): Promise<GatewayOrder>;
  /**
   * The order created with this receipt, if any. A retry uses it to find an
   * order that an earlier attempt created at Razorpay but crashed before storing.
   */
  findOrderByReceipt(receipt: string): Promise<GatewayOrder | undefined>;
  /**
   * Checks the signature Razorpay Checkout hands the browser after a payment.
   * Proves the browser saw a real payment; it does not confirm anything (the
   * webhook does).
   */
  verifyCheckoutSignature(input: CheckoutSignatureInput): boolean;
  /** Every payment made against an order: what the reconciler asks when a webhook never came. */
  listOrderPayments(orderId: string): Promise<GatewayPayment[]>;
  refundPayment(input: RefundInput): Promise<GatewayRefund>;
  /** A payment's refunds: how a retry finds the refund an earlier attempt already made. */
  listRefunds(paymentId: string): Promise<GatewayRefund[]>;
}

/** Razorpay could not be reached, timed out, or refused the request. */
export class GatewayError extends Error {
  /** HTTP status from Razorpay; undefined when it never answered. */
  readonly status: number | undefined;
  /** Razorpay's error code, e.g. BAD_REQUEST_ERROR. */
  readonly code: string | undefined;

  constructor(message: string, opts: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = 'GatewayError';
    this.status = opts.status;
    this.code = opts.code;
  }
}
