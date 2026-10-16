# 0010. Rate limits in Redis, shared by every replica; what happens when Redis is down

- Status: Accepted
- Date: 2026-10-16

## Context

Several API replicas serve the same users (M7 runs three behind nginx). A limit kept in each
process's memory would let a client through three times over, once per replica. Some routes need
protecting for different reasons:

- **Sign-in and sign-up:** password guessing and account farming. Needs an exact limit.
- **Seat holds and payment orders:** a bot cycling holds or hammering Razorpay through us.
- **Public browsing:** scraping and plain overload.

The limiter itself depends on Redis, so it needs an answer for when Redis is unreachable.

## Decision

- **Every check is one Lua script in Redis.** Reading the budget, deciding and updating it happen
  atomically, so all replicas draw on one budget per key. The script reads the time from Redis
  (`TIME`), not from the replica, so clock drift between replicas cannot refill a budget early.
- **Token bucket** for holds, payment orders and browsing: a full bucket allows a burst up to the
  limit, then an even rate. **Sliding window log** (a sorted set of request times) for sign-in and
  sign-up: exactly `limit` in any 60 seconds, with no double burst at a window edge; refused
  attempts do not extend the lockout.
- **Limits** (per minute): sign-in and sign-up 5 per IP; holds 10 per user; payment orders 5 per
  user; browsing 120 per IP. Webhooks are never limited: Razorpay retries, and every event is
  deduplicated anyway.
- **HTTP contract:** `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` on every limited
  route; `429 RATE_LIMITED` with `Retry-After` when refused.
- **When Redis is down** (or slower than 200 ms), each route class has a fixed answer:
  - **Fail closed** (503, `Retry-After: 5`) for sign-in and sign-up. Unlimited guessing during an
    outage is worse than a few seconds without new sessions; existing sessions keep working.
  - **Fail open** for everything else. Holds already work without Redis (the Postgres fallback,
    ADR 0005), and one hold per user per show caps what a bot can take; refusing every booking
    while Redis restarts would turn a cache outage into a sales outage. The plan first had holds
    failing closed; this is the deliberate change.

## Consequences

- One budget per user or IP across the cluster, proven by a test that runs three app instances,
  each with its own Redis connection, and allows exactly 10 of 30 holds.
- A Redis outage disables limits on most routes. That is visible in the logs
  (`rate limiter unavailable`) and short-lived; the routes stay correct, only unthrottled.
- Limiting by IP relies on `trust proxy` naming the real client; behind nginx (M7) that is one hop.
- k6 load tests through nginx in M7 repeat the cluster-wide check under real traffic.
