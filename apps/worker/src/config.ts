import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseEnvSchema, parseEnv } from '@bmt/platform';
import { z } from 'zod';

/** Repository root, resolved from this file (apps/worker/src/config.ts). */
export const ENV_FILE = path.join(fileURLToPath(new URL('../../../', import.meta.url)), '.env');

const workerEnvSchema = baseEnvSchema.extend({
  /** Hold-expiry jobs one worker runs at once. */
  HOLD_EXPIRY_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
  /** How often the sweeper looks for holds whose job was lost (ADR 0006). */
  HOLD_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).default(30_000),
  /** Holds released per sweep query; the sweeper repeats until a batch comes back short. */
  HOLD_SWEEP_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(500),
});

export type WorkerConfig = z.output<typeof workerEnvSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  return parseEnv(workerEnvSchema, env);
}
