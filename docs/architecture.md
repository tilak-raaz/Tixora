# Architecture

The living summary of how BookMyTicket fits together. It changes in the same PR as the design;
the reasoning behind each choice lives in [`adr/`](adr/).

## Shape

A modular monolith. One API codebase runs as several identical, stateless replicas behind nginx,
and separate worker processes handle everything slow or retryable.

```text
browser ──HTTPS──▶ nginx ──▶ api-1 │ api-2 │ api-3 ──▶ PostgreSQL 17 (source of truth)
                     ▲                      │      └──▶ Redis 7 (pre-locks, rate limits, cache, queues)
Razorpay ──webhooks──┘                      ▼
                                   worker processes ──▶ Resend (email), Razorpay (reconcile, refunds)
```

## Rules the design depends on

1. **Postgres decides seat ownership.** A seat changes owner only through a conditional update on
   its own `show_seats` row. Redis may reject requests early but never grants a seat.
2. **No external call inside a transaction.** A booking is two short transactions (hold, then
   confirm) with the payment in between.
3. **The webhook confirms payments**, never the browser callback. The reconciler covers webhooks
   that never arrive.
4. **Side effects go through the outbox.** A state change and the event announcing it commit together.
5. **Everything retried is idempotent:** idempotency keys on POSTs, event-ID dedupe on webhooks,
   `processed_messages` for queue consumers.
6. **The API holds no state in memory.** Any replica can serve any request.

## Code layout

| Path                | Role                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `apps/api`          | HTTP layer. Each module in `src/modules/<name>/` has `routes`, `service`, `repo`, `schemas`  |
| `apps/worker`       | Queue consumers, outbox relay, hold-expiry sweeper, payment reconciler                       |
| `packages/platform` | Server-only building blocks: env parsing, logger, Postgres pool, Redis, migrations, shutdown |
| `packages/shared`   | Types, schemas and constants safe to use in the browser                                      |
| `db/migrations`     | Forward-only SQL, applied by `packages/platform/src/migrate.ts`                              |

Routes parse and validate input, services hold business rules and own transactions, repos hold
SQL. Tests call services directly against a real database for concurrency work.

## Status by milestone

| Area                          | Milestone | State       |
| ----------------------------- | --------- | ----------- |
| Foundations                   | M0        | In progress |
| Accounts and catalog          | M1        | Planned     |
| Seat holds                    | M2        | Planned     |
| Payments                      | M3        | Planned     |
| Outbox and queues             | M4        | Planned     |
| Rate limiting and caching     | M5        | Planned     |
| Frontend                      | M6        | Planned     |
| Replicas, load, failure tests | M7        | Planned     |
| Deployment                    | M8        | Planned     |
