import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResendMailer, createSmtpMailer, type Mailer } from '@bmt/jobs';
import type { RazorpayConfig } from '@bmt/payments';
import {
  baseEnvSchema,
  optionalEnv,
  parseEnv,
  RAZORPAY_PAIR_ISSUE,
  razorpayEnvShape,
  razorpayKeysPaired,
} from '@bmt/platform';
import { z } from 'zod';

/** Repository root, resolved from this file (apps/worker/src/config.ts). */
export const ENV_FILE = path.join(fileURLToPath(new URL('../../../', import.meta.url)), '.env');

const workerEnvSchema = baseEnvSchema
  .extend({
    /** Hold-expiry jobs one worker runs at once. */
    HOLD_EXPIRY_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
    /** How often the sweeper looks for holds whose job was lost (ADR 0006). */
    HOLD_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).default(30_000),
    /** Holds released per sweep query; the sweeper repeats until a batch comes back short. */
    HOLD_SWEEP_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(500),
    /** Without Razorpay keys the worker runs hold expiry only: no refunds, no reconciler. */
    ...razorpayEnvShape,
    /** smtp sends to Mailpit (development); resend sends through Resend's API (production). */
    MAILER: z.enum(['smtp', 'resend']).default('smtp'),
    SMTP_URL: z.string().default('smtp://localhost:1025'),
    RESEND_API_KEY: optionalEnv(z.string().startsWith('re_', 'must start with re_')),
    EMAIL_FROM: z.string().default('BookMyTicket <tickets@bmt.local>'),
    /** How often the relay polls the outbox for committed events (ADR 0008). */
    OUTBOX_RELAY_INTERVAL_MS: z.coerce.number().int().min(50).default(500),
    /** How often refunds still PENDING are re-queued (ADR 0007). */
    REFUND_SWEEP_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .default(5 * 60_000),
    /** How often the reconciler asks Razorpay about unconfirmed orders. */
    RECONCILE_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .default(2 * 60_000),
    /** The API's PAYMENT_GATEWAY: with `fake`, payments never reached Razorpay, so neither do refunds. */
    PAYMENT_GATEWAY: optionalEnv(z.enum(['razorpay', 'fake'])),
    /** GET /metrics and /healthz for this worker (ADR 0015); 0 turns the server off. */
    METRICS_PORT: z.coerce.number().int().min(0).max(65_535).default(9100),
  })
  .refine(razorpayKeysPaired, RAZORPAY_PAIR_ISSUE)
  .refine((c) => c.MAILER !== 'resend' || Boolean(c.RESEND_API_KEY), {
    path: ['RESEND_API_KEY'],
    message: 'required when MAILER=resend',
  });

export type WorkerConfig = z.output<typeof workerEnvSchema>;

export function razorpayConfigFrom(config: WorkerConfig): RazorpayConfig | undefined {
  if (config.PAYMENT_GATEWAY === 'fake') return undefined;
  if (!config.RAZORPAY_KEY_ID || !config.RAZORPAY_KEY_SECRET) return undefined;
  return { keyId: config.RAZORPAY_KEY_ID, keySecret: config.RAZORPAY_KEY_SECRET };
}

export function mailerFrom(config: WorkerConfig): Mailer {
  return config.MAILER === 'resend'
    ? createResendMailer({ apiKey: config.RESEND_API_KEY!, from: config.EMAIL_FROM })
    : createSmtpMailer({ url: config.SMTP_URL, from: config.EMAIL_FROM });
}

export function loadConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  return parseEnv(workerEnvSchema, env);
}
