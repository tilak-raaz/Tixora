import { createLogger, createPool, createRedis, loadEnvFile, parseEnv } from '@bmt/platform';
import { z } from 'zod';
import { apiEnvSchema, authConfigFrom } from '../config';
import { createAuth } from '../modules/auth/auth';
import { ensureAdmin } from '../modules/auth/ensure-admin';
import { ENV_FILE } from '../paths';

// `make create-admin`: creates (or promotes) the admin from ADMIN_* in .env.
loadEnvFile(ENV_FILE);
const config = parseEnv(
  apiEnvSchema.extend({
    ADMIN_EMAIL: z.email(),
    ADMIN_PASSWORD: z.string().min(8),
    ADMIN_NAME: z.string().min(1).default('Admin'),
  }),
  process.env,
);

const logger = createLogger({
  name: 'create-admin',
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === 'development',
});
const pool = createPool({
  connectionString: config.DATABASE_URL,
  max: 2,
  applicationName: 'bmt-create-admin',
  logger,
});
const redis = createRedis(config.REDIS_URL, logger);
const auth = createAuth({ pool, redis, logger, config: authConfigFrom(config) });

try {
  const { userId, created } = await ensureAdmin(auth, pool, {
    email: config.ADMIN_EMAIL,
    password: config.ADMIN_PASSWORD,
    name: config.ADMIN_NAME,
  });
  logger.info(
    { userId, email: config.ADMIN_EMAIL },
    created ? 'admin created' : 'admin already existed; role confirmed',
  );
} catch (err) {
  logger.fatal({ err }, 'could not create admin');
  process.exitCode = 1;
} finally {
  await Promise.all([pool.end(), redis.quit()]);
}
