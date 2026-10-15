import { baseEnvSchema, parseEnv } from '@bmt/platform';
import { z } from 'zod';
import type { AuthConfig } from './modules/auth/auth';
import type { BookingConfig } from './modules/booking/service';
import { HOLD_STRATEGIES } from './modules/booking/strategies';

export const apiEnvSchema = baseEnvSchema.extend({
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

export function authConfigFrom(config: ApiConfig): AuthConfig {
  return {
    secret: config.BETTER_AUTH_SECRET,
    baseURL: config.BETTER_AUTH_URL,
    trustedOrigins: config.WEB_ORIGINS,
  };
}
