import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runMigrations } from '@bmt/platform';
import pg from 'pg';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../src/paths';

describe('real migrations', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: inject('databaseUrl') });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('applied every file in db/migrations during global setup', async () => {
    const { rows } = await pool.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    expect(rows.map((r) => r.version)).toContain('0001_extensions.sql');
  });

  it('installed btree_gist', async () => {
    const { rowCount } = await pool.query(
      "SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'",
    );
    expect(rowCount).toBe(1);
  });

  it('is a no-op when run again', async () => {
    const result = await runMigrations(pool, MIGRATIONS_DIR);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toContain('0001_extensions.sql');
  });
});

/**
 * Runner behaviour, each test in a fresh database so it can't disturb the
 * shared schema used by other test files.
 */
describe('migration runner', () => {
  let admin: Pool;
  let pool: Pool;
  let dbName: string;
  let dir: string;

  beforeAll(() => {
    admin = new pg.Pool({ connectionString: inject('databaseUrl') });
  });
  afterAll(async () => {
    await admin.end();
  });

  beforeEach(async () => {
    dbName = `migrate_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(inject('databaseUrl'));
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    dir = await mkdtemp(path.join(tmpdir(), 'bmt-migrations-'));
  });

  afterEach(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await rm(dir, { recursive: true, force: true });
  });

  it('applies files in name order', async () => {
    await writeFile(path.join(dir, '0002_b.sql'), 'ALTER TABLE a ADD COLUMN note text;');
    await writeFile(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (id int PRIMARY KEY);');

    const result = await runMigrations(pool, dir);

    expect(result.applied).toEqual(['0001_a.sql', '0002_b.sql']);
  });

  it('rolls back a failing migration completely and reports which file failed', async () => {
    await writeFile(
      path.join(dir, '0001_bad.sql'),
      'CREATE TABLE half (id int); SELECT * FROM table_that_does_not_exist;',
    );

    await expect(runMigrations(pool, dir)).rejects.toThrow(/0001_bad\.sql failed/);

    const { rowCount } = await pool.query("SELECT 1 FROM pg_tables WHERE tablename = 'half'");
    expect(rowCount).toBe(0);
  });

  it('refuses to run if an applied migration was edited', async () => {
    const file = path.join(dir, '0001_a.sql');
    await writeFile(file, 'CREATE TABLE a (id int PRIMARY KEY);');
    await runMigrations(pool, dir);

    await writeFile(file, 'CREATE TABLE a (id bigint PRIMARY KEY);');

    await expect(runMigrations(pool, dir)).rejects.toThrow(/was edited after it was applied/);
  });

  it('rejects badly named files', async () => {
    await writeFile(path.join(dir, 'add_users.sql'), 'SELECT 1;');
    await expect(runMigrations(pool, dir)).rejects.toThrow(/Bad migration file name/);
  });

  it('applies each migration exactly once when several processes race', async () => {
    // Without the advisory lock, these runners would all try to apply 0001 at once.
    await writeFile(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (id int PRIMARY KEY);');

    const results = await Promise.all([1, 2, 3, 4].map(() => runMigrations(pool, dir)));

    const appliedCount = results.reduce((sum, r) => sum + r.applied.length, 0);
    expect(appliedCount).toBe(1);
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM schema_migrations',
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });
});
