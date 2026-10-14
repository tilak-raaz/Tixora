# Changelog

All notable changes are recorded here, one section per release tag.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions: [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Accounts with Better Auth (ADR 0004): email + password sign-up, sign-in and sign-out under `/api/auth`
- Sessions in Redis shared by every API replica, also written to Postgres
- `0002_identity.sql`: `users`, `sessions`, `accounts`, and a shared `set_updated_at()` trigger
- `GET /api/v1/me`; `requireAuth` and `requireRole` middleware; `user` and `admin` roles
- `make create-admin`: creates or promotes the admin from `ADMIN_*` in `.env`
- Integration test that fails if the migration drifts from Better Auth's expected schema

## [0.1.0] - 2026-10-14

M0: foundations.

### Added

- npm workspaces monorepo: `apps/api`, `apps/worker`, `packages/platform`, `packages/shared`
- Docker Compose for Postgres 17, Redis 7 and Mailpit; `Makefile` targets
- Forward-only SQL migration runner with checksums and an advisory lock; `0001_extensions.sql`
- Express 5 API skeleton: validated config, pino request logging with request IDs, standard error body, `/healthz` and `/readyz`, graceful shutdown
- Worker process skeleton with graceful shutdown
- Vitest unit tests and Testcontainers integration tests
- GitHub Actions CI, PR and issue templates, Conventional Commits via commitlint and husky
- Docs: architecture overview, ADRs 0001 to 0003, local setup runbook

[Unreleased]: https://github.com/tilak-raaz/book-my-ticket/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/tilak-raaz/book-my-ticket/releases/tag/v0.1.0
