# 0002. Raw SQL with `pg` and a small migration runner

- Status: Accepted
- Date: 2026-10-14

## Context

The core of the project is precise control over transactions: conditional updates checked by row
count, `SELECT ... FOR UPDATE` with a deliberate lock order, `SKIP LOCKED` for the outbox relay,
exclusion constraints and partial indexes. ORMs such as Prisma hide or complicate exactly these.

## Decision

Use `pg` (node-postgres) directly. SQL lives in each module's `repo.ts`, with parameters always
passed separately (`$1`, `$2`), never interpolated. The schema is written as plain `.sql` migration
files, applied by a ~100-line runner in `packages/platform/src/migrate.ts` that is forward-only,
stores a checksum per file, and takes a Postgres advisory lock so concurrent processes cannot apply
a migration twice.

## Consequences

- Every query is visible and reviewable; locking behaviour is explicit.
- No generated types: row types are declared by hand next to each query, and integration tests
  catch mismatches.
- No down migrations. Mistakes are fixed by a new forward migration, which is how production
  systems usually work anyway.
- Statements that cannot run in a transaction (`CREATE INDEX CONCURRENTLY`) are not supported by
  the runner yet.
