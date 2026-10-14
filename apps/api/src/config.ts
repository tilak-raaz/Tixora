import { baseEnvSchema, parseEnv } from '@bmt/platform';
import { z } from 'zod';

const apiEnvSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
});

export type ApiConfig = z.output<typeof apiEnvSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  return parseEnv(apiEnvSchema, env);
}
