# 0006. Hold expiry: a delayed job per hold, with a Postgres-only sweeper behind it

- Status: Accepted
- Date: 2026-10-15

## Context

A hold lasts 5 minutes. When it runs out, its booking should become `EXPIRED` and its seats
`AVAILABLE` again.

Nothing here protects against double booking. The hold query already treats a seat whose hold has
run out as free, so a second buyer can take it the moment the first hold expires, cleaned up or
not (ADR 0005). Expiry keeps the data true for everything that reads it: the seat map, "my
bookings", reports, and from M4 the "your hold expired" email, which needs an event close to the
moment it happens.

Options considered:

1. **A sweeper only:** every N seconds, expire everything overdue. Simple and robust, but a hold
   stays `PENDING_PAYMENT` for up to N seconds after it ends, and every worker scans the table
   whether or not anything is due.
2. **A delayed job only:** the API queues a BullMQ job set to run at `expires_at`. Precise, but a
   job can be lost: the API can crash between committing the hold and queueing the job, Redis can
   lose recent writes on a restart, and jobs wait while every worker is down.
3. **A Redis key that expires (keyspace notifications):** notifications are fire-and-forget; one
   sent while no subscriber is connected is gone.

## Decision

Both 1 and 2, sharing one conditional update, with Postgres deciding:

- **Delayed job per hold.** After the hold commits, the API queues `hold-expiry` with the booking
  id as the job id and a delay of `expires_at` + 1 s (the margin covers a Node clock ahead of
  Postgres's). The same booking can never be queued twice. Queueing waits at most 1 s and never
  fails the request: the hold already exists, so a Redis problem is logged and left to the sweeper.
- **One conditional update.** The job expires a booking only if it is still `PENDING_PAYMENT` and
  past `expires_at`, and frees only the seats that still point at that booking. A late job, a
  duplicate, a job for a booking that was paid or cancelled, or a seat another buyer has taken
  since: all leave the data alone.
- **Sweeper as the safety net.** Every worker sweeps once at start-up and then every 30 s (with
  jitter), expiring overdue holds in batches of 500 with `FOR NO KEY UPDATE SKIP LOCKED`. Several
  sweepers never release the same hold twice or wait for each other. The sweeper uses only
  Postgres, so it keeps working when the queue it backs up does not.
- **The worker owns the queue and its SQL** in `packages/jobs` (`@bmt/jobs`); the API depends on
  it only to queue jobs.

## Consequences

- A hold normally ends within about a second of `expires_at`; in the worst case (job lost) within
  one sweep interval. Readers that need the exact answer sooner already get it: the hold query
  and `GET /bookings/:id` both treat an overdue hold as expired.
- A dead Redis or a crashed API never strands a hold, and never fails a booking request.
- BullMQ keeps its own Redis connections (it needs `maxRetriesPerRequest: null`), and the Redis
  must not evict keys (`noeviction`, the default) or delayed jobs could vanish. This is checked
  again when Redis is configured for production in M8.
- The tests cover the job, the late, duplicate and stale cases, Redis being down, concurrent
  sweepers, and a hold expiring end to end through a real queue and worker.
