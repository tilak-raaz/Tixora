import { baseEnvSchema, parseEnv } from '@bmt/platform';
import { z } from 'zod';
import type { AuthConfig } from './modules/auth/auth';

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
});

export type ApiConfig = z.output<typeof apiEnvSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  return parseEnv(apiEnvSchema, env);
}

export function authConfigFrom(config: ApiConfig): AuthConfig {
  return {
    secret: config.BETTER_AUTH_SECRET,
    baseURL: config.BETTER_AUTH_URL,
    trustedOrigins: config.WEB_ORIGINS,
  };
}
