import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import type { Logger } from 'pino';

/** NNNN_snake_case.sql, e.g. 0002_identity.sql */
const FILE_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

/**
 * Arbitrary constant used as the advisory-lock key. Every process that runs
 * migrations takes this lock first, so two replicas starting at once can never
 * apply the same migration twice.
 */
const MIGRATION_LOCK_KEY = 727_262_001;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Forward-only SQL migration runner.
 *
 * - Applies every *.sql file in `dir` in file-name order, each in its own transaction.
 * - Records file name + SHA-256 checksum in schema_migrations.
 * - Refuses to continue if an already-applied file has been edited.
 * - Serialised across processes with a Postgres advisory lock.
 *
 * Statements that cannot run inside a transaction (CREATE INDEX CONCURRENTLY)
 * are not supported; nothing in this project needs them yet.
 */
export async function runMigrations(
  pool: Pool,
  dir: string,
  logger?: Logger,
): Promise<MigrationResult> {
  const files = (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort();
  assertValidNames(files);

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const alreadyApplied = new Map(rows.map((row) => [row.version, row.checksum]));

    const result: MigrationResult = { applied: [], skipped: [] };
    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');

      const previous = alreadyApplied.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${file} was edited after it was applied. Revert the edit and add a new migration instead.`,
          );
        }
        result.skipped.push(file);
        continue;
      }

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      result.applied.push(file);
      logger?.info({ migration: file }, 'applied migration');
    }
    return result;
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
    client.release();
  }
}

function assertValidNames(files: string[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    if (!FILE_NAME.test(file)) {
      throw new Error(`Bad migration file name "${file}": expected NNNN_snake_case.sql`);
    }
    const number = file.slice(0, 4);
    if (seen.has(number)) {
      throw new Error(`Two migrations share the number ${number}`);
    }
    seen.add(number);
  }
}
