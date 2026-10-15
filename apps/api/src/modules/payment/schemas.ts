import { z } from 'zod';

/** What Razorpay Checkout hands the browser after a payment, passed on as is. */
export const verifyCheckoutSchema = z.object({
  razorpayOrderId: z.string().min(1).max(100),
  razorpayPaymentId: z.string().min(1).max(100),
  razorpaySignature: z.string().regex(/^[0-9a-f]{64}$/, 'must be a hex HMAC-SHA256'),
});

export type VerifyCheckoutInput = z.output<typeof verifyCheckoutSchema>;
