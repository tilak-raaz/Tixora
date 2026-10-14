import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseEnvSchema, parseEnv } from '@bmt/platform';
import type { z } from 'zod';

/** Repository root, resolved from this file (apps/worker/src/config.ts). */
export const ENV_FILE = path.join(fileURLToPath(new URL('../../../', import.meta.url)), '.env');

// Queue-specific settings (concurrency per queue, retry limits) are added in M4.
const workerEnvSchema = baseEnvSchema;

export type WorkerConfig = z.output<typeof workerEnvSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  return parseEnv(workerEnvSchema, env);
}
