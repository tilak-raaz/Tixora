# BookMyTicket

A BookMyShow-style movie ticket booking platform, built to learn and prove distributed-systems
patterns under real contention: seat locking, holds that expire, payment idempotency, reliable
async processing and distributed rate limiting.

> **Status: M2 done (seat holds, v0.3.0); M3 next (payments).** Only what is listed under "What works today" is built. Everything
> else is on the [roadmap](#roadmap) and appears here only once it has a test or a benchmark
> behind it.

## What works today

- API and worker processes with validated configuration, structured logs and graceful shutdown
- Accounts with Better Auth: email + password sign-up and sign-in, sessions shared across
  replicas through Redis (and kept in Postgres), `user` and `admin` roles
- Catalog: admins manage theatres, screens with seat layouts, movies and shows; anyone can
  browse what is playing in a city on a date and see a show's seat map
- Seat holds: up to 5 seats for 5 minutes, all or nothing, safe under contention across replicas
  (200 simultaneous buyers for one seat produce exactly one winner, proven by test), with
  idempotent retries
- Hold expiry: a delayed job per hold releases its seats when the hold runs out, and a sweeper in
  every worker catches any job that was lost, so a crash or a Redis outage never strands seats
- Liveness (`GET /healthz`) and readiness (`GET /readyz`, checks Postgres and Redis)
- SQL migrations with checksums, safe to run from several processes at once
- Unit tests, plus integration tests against real Postgres and Redis containers

## Stack

TypeScript (strict) on Node.js 24 · Express 5 · Better Auth · PostgreSQL 17 with raw SQL via `pg` · Redis 7 · BullMQ ·
Zod · pino · Vitest + Testcontainers · Docker Compose · GitHub Actions

## Quickstart

Requires Node.js 24 (`nvm use`), Docker Desktop and `make`.

```bash
cp .env.example .env
npm install
make up          # Postgres, Redis, Mailpit
make migrate
make create-admin  # admin account from ADMIN_* in .env
make seed          # demo city, theatres, movies and a week of shows
make dev-api     # http://localhost:4000/readyz
make dev-worker  # hold expiry (second terminal)
make test        # unit + integration (starts its own containers)
```

`make help` lists every target. Full setup notes: [docs/runbooks/local-setup.md](docs/runbooks/local-setup.md).

## Repository layout

```text
apps/api          Express API (modules mount under /api/v1)
apps/worker       Background jobs: outbox relay, email, hold expiry, reconciliation
packages/jobs     Background jobs (BullMQ queues and their SQL), shared by API and worker
packages/platform Server-side building blocks: env, logger, Postgres, Redis, migrations
packages/shared   Types and constants shared with the frontend
db/migrations     Forward-only SQL migrations (NNNN_name.sql)
infra             Docker Compose (nginx and k6 arrive in M7)
docs              Architecture, ADRs, runbooks, benchmarks, lessons
```

## Docs

- [Architecture](docs/architecture.md)
- [Architecture Decision Records](docs/adr/)
- [Lessons learned](docs/lessons.md)
- [Changelog](CHANGELOG.md)

## Roadmap

| Milestone | Tag      | Scope                                                      |
| --------- | -------- | ---------------------------------------------------------- |
| M0        | `v0.1.0` | Foundations: repo, infra, migrations, CI                   |
| M1        | `v0.2.0` | Accounts and catalog                                       |
| M2        | `v0.3.0` | Seat holds and concurrency (three strategies, benchmarked) |
| M3        | `v0.4.0` | Razorpay payments, webhooks, refunds, reconciliation       |
| M4        | `v0.5.0` | Outbox, queues, email tickets                              |
| M5        | `v0.6.0` | Distributed rate limiting and caching                      |
| M6        | `v0.7.0` | Next.js frontend                                           |
| M7        | `v0.8.0` | Three replicas, load tests, failure drills                 |
| M8        | `v1.0.0` | Deployment and release                                     |

## Results

- **Seat holds:** 0 double bookings with 200 buyers on one seat across 3 replicas, for all three
  locking strategies. Putting a Redis lock in front of Postgres cut median hold latency under
  contention from 193 ms to 7 ms, which overturned the first choice of default
  ([benchmark](docs/benchmarks/m2-hold-strategies.md), [ADR 0005](docs/adr/0005-seat-hold-strategy.md)).
