import { createLogger, createPool, createRedis } from '@bmt/platform';
import { inject } from 'vitest';
import { createAuth, type AuthConfig } from '../../src/modules/auth/auth';

/** The web app's origin in tests. Auth POSTs must send it, as a browser would. */
export const WEB_ORIGIN = 'http://localhost:3000';

export const TEST_AUTH_CONFIG: AuthConfig = {
  secret: 'test-secret-that-is-at-least-32-characters-long',
  baseURL: 'http://localhost:4000',
  trustedOrigins: [WEB_ORIGIN],
};

/**
 * Real Postgres + Redis connections to the containers from global-setup.ts.
 * Each call is an independent set of clients, like a separate API replica.
 */
export function createTestDeps() {
  const logger = createLogger({ name: 'test', level: 'silent' });
  const pool = createPool({
    connectionString: inject('databaseUrl'),
    max: 5,
    applicationName: 'bmt-test',
    logger,
  });
  const redis = createRedis(inject('redisUrl'), logger);
  const auth = createAuth({ pool, redis, logger, config: TEST_AUTH_CONFIG });

  return {
    logger,
    pool,
    redis,
    auth,
    close: async () => {
      await Promise.all([pool.end(), redis.quit()]);
    },
  };
}
