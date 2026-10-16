import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RazorpayConfig } from '@bmt/payments';
import {
  baseEnvSchema,
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
  })
  .refine(razorpayKeysPaired, RAZORPAY_PAIR_ISSUE);

export type WorkerConfig = z.output<typeof workerEnvSchema>;

export function razorpayConfigFrom(config: WorkerConfig): RazorpayConfig | undefined {
  if (!config.RAZORPAY_KEY_ID || !config.RAZORPAY_KEY_SECRET) return undefined;
  return { keyId: config.RAZORPAY_KEY_ID, keySecret: config.RAZORPAY_KEY_SECRET };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  return parseEnv(workerEnvSchema, env);
}
