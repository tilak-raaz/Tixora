import { createLogger, createPool, withTransaction } from '@bmt/platform';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * Found by the Postgres failure drill (ADR 0017): a restart cut a connection that a worker had
 * checked out in the middle of a transaction. pg emitted 'error' on that client, nothing listened,
 * Node turned it into an uncaught exception and the worker exited. A lost connection must fail
 * the work in progress, not the process.
 */

const logger = createLogger({ name: 'test', level: 'silent' });
let pool: ReturnType<typeof createPool>;
let admin: ReturnType<typeof createPool>;

beforeAll(() => {
  pool = createPool({
    connectionString: inject('databaseUrl'),
    max: 2,
    applicationName: 'bmt-test-victim',
    logger,
  });
  admin = createPool({
    connectionString: inject('databaseUrl'),
    max: 1,
    applicationName: 'bmt-test-admin',
    logger,
  });
});
afterAll(async () => {
  await Promise.all([pool.end(), admin.end()]);
});

describe('a connection lost while checked out', () => {
  it('fails the transaction and leaves the pool working', async () => {
    const work = withTransaction(pool, async (tx) => {
      const { rows } = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      // Cut this very connection from outside while the transaction holds it between queries,
      // as a database restart would.
      await admin.query('SELECT pg_terminate_backend($1)', [rows[0]!.pid]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await tx.query('SELECT 1');
    });

    await expect(work).rejects.toThrow();
    // The broken client was thrown away; the pool opens a fresh connection.
    const { rows } = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    expect(rows[0]!.ok).toBe(1);
  });
});
