import { existsSync } from 'node:fs';
import { z } from 'zod';

/** Variables every server process (API and worker) needs. Apps extend this. */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  REDIS_URL: z.string().min(1),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

export type BaseEnv = z.output<typeof baseEnvSchema>;

/** An optional variable where an empty value in .env (KEY=) means "not set". */
export function optionalEnv<S extends z.ZodType>(schema: S) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
}

/** Razorpay keys, shared by the API and the worker. Both or neither. */
export const razorpayEnvShape = {
  RAZORPAY_KEY_ID: optionalEnv(
    z.string().regex(/^rzp_(test|live)_/, 'must start with rzp_test_ or rzp_live_'),
  ),
  RAZORPAY_KEY_SECRET: optionalEnv(z.string().min(1)),
};

export function razorpayKeysPaired(c: {
  RAZORPAY_KEY_ID?: string | undefined;
  RAZORPAY_KEY_SECRET?: string | undefined;
}): boolean {
  return Boolean(c.RAZORPAY_KEY_ID) === Boolean(c.RAZORPAY_KEY_SECRET);
}

export const RAZORPAY_PAIR_ISSUE = {
  path: ['RAZORPAY_KEY_SECRET'],
  message: 'set both RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET, or neither',
};

/**
 * Validates the environment against a schema. Fails fast with every problem
 * listed at once, so a misconfigured process never half-starts.
 */
export function parseEnv<S extends z.ZodType>(
  schema: S,
  env: Record<string, string | undefined>,
): z.output<S> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  - ${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}

/** Loads a .env file into process.env if it exists. Real env vars win. */
export function loadEnvFile(path: string): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
