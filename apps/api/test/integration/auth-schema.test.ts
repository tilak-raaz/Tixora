import { getMigrations } from 'better-auth/db/migration';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDeps } from './helpers';

/**
 * Our identity tables are hand-written SQL (0002_identity.sql), but Better Auth
 * decides which tables and columns it needs. This asks Better Auth to compare
 * its expected schema with the migrated database: anything it would still need
 * to create or add means the migration and the mapping in auth.ts have drifted.
 */
describe('auth schema', () => {
  let deps: ReturnType<typeof createTestDeps>;

  beforeAll(() => {
    deps = createTestDeps();
  });
  afterAll(async () => {
    await deps.close();
  });

  it('matches what Better Auth expects', async () => {
    const { toBeCreated, toBeAdded } = await getMigrations(deps.auth.options);
    expect(toBeCreated).toEqual([]);
    expect(toBeAdded).toEqual([]);
  });
});
