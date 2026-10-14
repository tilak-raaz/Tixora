import { runMigrations } from '@bmt/platform';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { GenericContainer } from 'testcontainers';
import type { TestProject } from 'vitest/node';
import { MIGRATIONS_DIR } from '../../src/paths';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

/**
 * Runs once per `vitest run`: starts throwaway Postgres and Redis containers,
 * applies every migration, and hands the connection URLs to the tests through
 * provide/inject. The containers are removed when the run ends.
 */
export default async function setup(project: TestProject) {
  const [postgres, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine').start(),
    new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
  ]);

  const databaseUrl = postgres.getConnectionUri();
  const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;

  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await runMigrations(pool, MIGRATIONS_DIR);
  } finally {
    await pool.end();
  }

  project.provide('databaseUrl', databaseUrl);
  project.provide('redisUrl', redisUrl);

  return async () => {
    await Promise.all([postgres.stop(), redis.stop()]);
  };
}
