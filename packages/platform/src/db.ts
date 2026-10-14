import pg from 'pg';
import type { Pool, PoolClient } from 'pg';
import type { Logger } from 'pino';

export type { Pool, PoolClient };

export interface PoolConfig {
  connectionString: string;
  max: number;
  applicationName: string;
  logger: Logger;
}

export function createPool(config: PoolConfig): Pool {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
    // Shows up in pg_stat_activity, so you can tell api and worker connections apart.
    application_name: config.applicationName,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  // An idle client can lose its connection (e.g. Postgres restart). Log it; the pool
  // discards that client and opens a new one on demand. Crashing here would turn a
  // database blip into an outage.
  pool.on('error', (err) => config.logger.error({ err }, 'idle postgres client error'));
  return pool;
}

/**
 * Runs fn inside BEGIN/COMMIT on one dedicated connection. Any throw rolls back.
 * Never call external services (Razorpay, email) inside fn: a transaction must
 * stay short because it holds row locks and a pooled connection.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
