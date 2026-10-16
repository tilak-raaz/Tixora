import { api } from './api';

/** What POST /bookings/:id/payment-order returns: everything Checkout needs. */
export interface PaymentOrder {
  bookingId: string;
  razorpayOrderId: string;
  amountPaise: number;
  currency: string;
  keyId: string;
  expiresAt: string;
  /** `fake` (PAYMENT_GATEWAY=fake) opens the test sheet instead of Razorpay Checkout. */
  checkout: 'razorpay' | 'fake';
}

/** What Checkout hands the browser after a successful payment. */
export interface CheckoutSuccess {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}

export async function createPaymentOrder(bookingId: string): Promise<PaymentOrder> {
  const { order } = await api<{ order: PaymentOrder }>(
    `/bookings/${encodeURIComponent(bookingId)}/payment-order`,
    { method: 'POST' },
  );
  return order;
}

/** Checks Checkout's signature. It proves the payment happened; it does not confirm the booking. */
export async function verifyPayment(bookingId: string, success: CheckoutSuccess): Promise<void> {
  await api(`/bookings/${encodeURIComponent(bookingId)}/payment/verify`, {
    method: 'POST',
    json: success,
  });
}

/** The fake payment mode's "Checkout": pays or fails, then the API sends itself the webhook. */
export async function payFake(
  bookingId: string,
  outcome: 'paid' | 'failed',
): Promise<CheckoutSuccess | null> {
  const res = await api<CheckoutSuccess | { failed: true }>(
    `/dev/fake-payments/${encodeURIComponent(bookingId)}`,
    { method: 'POST', json: { outcome } },
  );
  return 'failed' in res ? null : res;
}

// ---------------------------------------------------------------------------
// Razorpay Checkout (https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/)
// ---------------------------------------------------------------------------

interface RazorpayResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

interface RazorpayInstance {
  open(): void;
  on(
    event: 'payment.failed',
    handler: (response: { error: { description?: string } }) => void,
  ): void;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

const CHECKOUT_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';
let scriptLoading: Promise<void> | undefined;

function loadCheckoutScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  scriptLoading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CHECKOUT_SCRIPT;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptLoading = undefined;
      reject(new Error('Razorpay Checkout did not load'));
    };
    document.head.appendChild(script);
  });
  return scriptLoading;
}

export type CheckoutOutcome =
  | { kind: 'paid'; success: CheckoutSuccess }
  | { kind: 'failed'; reason: string }
  | { kind: 'closed' };

/** Opens Razorpay Checkout and resolves when the buyer pays, a payment fails, or they close it. */
export async function openRazorpayCheckout(
  order: PaymentOrder,
  details: { name: string; description: string; buyer?: { name?: string; email?: string } },
): Promise<CheckoutOutcome> {
  await loadCheckoutScript();
  const Razorpay = window.Razorpay;
  if (!Razorpay) throw new Error('Razorpay Checkout did not load');

  return new Promise<CheckoutOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: CheckoutOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const checkout = new Razorpay({
      key: order.keyId,
      order_id: order.razorpayOrderId,
      amount: order.amountPaise,
      currency: order.currency,
      name: details.name,
      description: details.description,
      prefill: details.buyer,
      theme: { color: '#c8102e' },
      handler: (response: RazorpayResponse) =>
        settle({
          kind: 'paid',
          success: {
            razorpayOrderId: response.razorpay_order_id,
            razorpayPaymentId: response.razorpay_payment_id,
            razorpaySignature: response.razorpay_signature,
          },
        }),
      modal: { ondismiss: () => settle({ kind: 'closed' }) },
    });
    checkout.on('payment.failed', (response) =>
      settle({
        kind: 'failed',
        reason: response.error.description ?? 'The payment did not go through.',
      }),
    );
    checkout.open();
  });
}
