import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Razorpay signs two things with HMAC-SHA256, hex-encoded:
 *  - Checkout's success callback: `order_id|payment_id`, keyed with the key secret
 *  - Webhooks: the raw request body, keyed with the webhook secret
 * Comparisons are constant-time, so response timing reveals nothing about a
 * correct signature.
 */

export function hmacSha256Hex(secret: string, data: string | Buffer): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function checkoutSignature(orderId: string, paymentId: string, keySecret: string): string {
  return hmacSha256Hex(keySecret, `${orderId}|${paymentId}`);
}

export function verifyCheckoutSignature(
  input: { orderId: string; paymentId: string; signature: string },
  keySecret: string,
): boolean {
  return safeEqual(checkoutSignature(input.orderId, input.paymentId, keySecret), input.signature);
}

/** Signs the raw body exactly as received; a re-serialised JSON body would not match. */
export function webhookSignature(rawBody: string | Buffer, webhookSecret: string): string {
  return hmacSha256Hex(webhookSecret, rawBody);
}

export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signature: string,
  webhookSecret: string,
): boolean {
  return safeEqual(webhookSignature(rawBody, webhookSecret), signature);
}

function safeEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
