# 0004. Better Auth for identity, sessions in Redis and Postgres

- Status: Accepted
- Date: 2026-10-15

## Context

The project needs sign-up, sign-in, sessions and an admin role. Authentication is not what the
project sets out to prove (seat contention, payments, queues and rate limiting are), and
hand-written auth is a common source of security bugs: password hashing parameters, token
rotation, cookie flags, CSRF and timing attacks. The API runs as several stateless replicas, so
any replica must be able to validate any session.

Options considered: a hand-written JWT access token plus rotating refresh token; Auth.js (tied
closely to Next.js); Better Auth (framework-agnostic, TypeScript-first, runs inside Express).

## Decision

Use Better Auth inside the Express API, mounted at `/api/auth`, with:

- **Email and password** sign-in, the **admin plugin** for the `user` / `admin` role.
- **Database sessions with an httpOnly cookie** (`bmt.session_token`), not JWTs, so a session can
  be revoked immediately.
- **Redis as secondary storage**, so every replica reads sessions from one shared store without a
  Postgres query per request, and **sessions also written to Postgres**
  (`storeSessionInDatabase`) so a Redis flush does not sign everyone out.
- **Our naming, not Better Auth's defaults:** plural tables, snake_case columns, uuid ids. The
  schema is hand-written in `0002_identity.sql` so our migration runner stays the only thing that
  changes the database. An integration test asks Better Auth's own `getMigrations` whether
  anything is missing, which catches drift.
- **Our own guards** `requireAuth` and `requireRole` for every non-auth route, so feature modules
  do not depend on Better Auth directly.
- **Admins are created only by `make create-admin`.** There is no API path to the admin role.

## Consequences

- Password hashing, cookie security and CSRF origin checks come from a maintained library.
- Better Auth's endpoints return their own error shape (`{ code, message }`), not our
  `{ error: { ... } }` body. Everything under `/api/v1` keeps our shape.
- A user promoted to admin while signed in must sign in again: the session caches the user.
- The version is pinned exactly (it changes quickly); upgrades are deliberate PRs with the
  schema test as the safety net.
- Better Auth's built-in rate limiter (counters in Redis) protects sign-in until our own
  distributed limiter replaces it in M5.
