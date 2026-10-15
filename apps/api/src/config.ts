import type { RazorpayConfig } from '@bmt/payments';
import { baseEnvSchema, parseEnv } from '@bmt/platform';
import { z } from 'zod';
import type { AuthConfig } from './modules/auth/auth';
import type { BookingConfig } from './modules/booking/service';
import { HOLD_STRATEGIES } from './modules/booking/strategies';

/** An empty value in .env (KEY=) means "not set". */
const optional = <S extends z.ZodType>(schema: S) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

export const apiEnvSchema = baseEnvSchema
  .extend({
    PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    BETTER_AUTH_SECRET: z.string().min(32, 'must be at least 32 characters'),
    BETTER_AUTH_URL: z.url().default('http://localhost:4000'),
    /** Comma-separated browser origins allowed to call the API (the web app). */
    WEB_ORIGINS: z
      .string()
      .default('http://localhost:3000')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    /** How long held seats stay reserved for payment. */
    HOLD_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    MAX_SEATS_PER_BOOKING: z.coerce.number().int().min(1).max(20).default(5),
    /** How seats are taken: redis (default), conditional or pessimistic (ADR 0005). */
    HOLD_STRATEGY: z.enum(HOLD_STRATEGIES).default('redis'),
    /** Razorpay test or live keys. Without them the payment endpoints answer 503. */
    RAZORPAY_KEY_ID: optional(
      z.string().regex(/^rzp_(test|live)_/, 'must start with rzp_test_ or rzp_live_'),
    ),
    RAZORPAY_KEY_SECRET: optional(z.string().min(1)),
    /** Set in M3 PR 3, when webhooks arrive. */
    RAZORPAY_WEBHOOK_SECRET: optional(z.string().min(1)),
  })
  .refine((c) => Boolean(c.RAZORPAY_KEY_ID) === Boolean(c.RAZORPAY_KEY_SECRET), {
    path: ['RAZORPAY_KEY_SECRET'],
    message: 'set both RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET, or neither',
  });

export type ApiConfig = z.output<typeof apiEnvSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  return parseEnv(apiEnvSchema, env);
}

export function bookingConfigFrom(config: ApiConfig): BookingConfig {
  return {
    holdTtlSeconds: config.HOLD_TTL_SECONDS,
    maxSeatsPerBooking: config.MAX_SEATS_PER_BOOKING,
    strategy: config.HOLD_STRATEGY,
  };
}

/** Undefined when no keys are set: the API still runs, without payments. */
export function razorpayConfigFrom(config: ApiConfig): RazorpayConfig | undefined {
  if (!config.RAZORPAY_KEY_ID || !config.RAZORPAY_KEY_SECRET) return undefined;
  return { keyId: config.RAZORPAY_KEY_ID, keySecret: config.RAZORPAY_KEY_SECRET };
}

export function authConfigFrom(config: ApiConfig): AuthConfig {
  return {
    secret: config.BETTER_AUTH_SECRET,
    baseURL: config.BETTER_AUTH_URL,
    trustedOrigins: config.WEB_ORIGINS,
  };
}
