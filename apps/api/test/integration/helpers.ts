import { createLogger, createPool, createRedis } from '@bmt/platform';
import { inject } from 'vitest';

/** Real Postgres + Redis connections to the containers from global-setup.ts. */
export function createTestDeps() {
  const logger = createLogger({ name: 'test', level: 'silent' });
  const pool = createPool({
    connectionString: inject('databaseUrl'),
    max: 5,
    applicationName: 'bmt-test',
    logger,
  });
  const redis = createRedis(inject('redisUrl'), logger);

  return {
    logger,
    pool,
    redis,
    close: async () => {
      await Promise.all([pool.end(), redis.quit()]);
    },
  };
}
