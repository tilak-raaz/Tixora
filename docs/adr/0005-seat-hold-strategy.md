# 0005. Redis pre-lock in front of a conditional update; Postgres decides

- Status: Accepted
- Date: 2026-10-15

## Context

Holding seats is the one operation where many requests fight over the same rows. A naive
read-then-write lets every racer win (see [lessons](../lessons.md)). Three correct approaches were
built behind one `SeatHoldStrategy` interface, and all three pass the same concurrency suite
(200 buyers on one seat across 3 replicas, overlapping multi-seat requests, one user tapping
twice):

1. **conditional:** one statement. A CTE locks the requested rows in id order, then the `UPDATE`
   changes only rows that are still free. Postgres re-checks the condition after any lock wait.
2. **pessimistic:** `SELECT ... FOR UPDATE` in id order, decide in application code, then
   `UPDATE`. Same guarantees, one extra round trip while the locks are held.
3. **redis:** an all-or-nothing Redis lock (Lua script, per-request token, 5 s safety TTL) taken
   before the hold transaction and released after it, in front of the conditional update.

The first draft of this ADR chose `conditional` as the default, on simplicity: fewest moving
parts, nothing but Postgres. The benchmark
([docs/benchmarks/m2-hold-strategies.md](../benchmarks/m2-hold-strategies.md)) overturned that.
Median-of-3 results, 300 buyers through 3 replicas with 30 Postgres connections in total:

| Scenario                   | conditional p50 | redis p50 | conditional wall | redis wall |
| -------------------------- | --------------: | --------: | ---------------: | ---------: |
| One hot seat               |          193 ms |      7 ms |           465 ms |      23 ms |
| Hot row (20 seats, 2 each) |          157 ms |      6 ms |           290 ms |      20 ms |
| No contention              |          382 ms |    332 ms |           445 ms |     366 ms |

Every loser in the contended scenarios (299 of 299, 292 of 292) was turned away by Redis. Without
the filter, each loser takes one of the 30 Postgres connections and queues on the row lock, so
losers slow down everyone, the winner included. With no contention, Redis costs nothing (it was
not slower in any run). The benchmark was run twice: absolute numbers moved by up to 40% between
runs, but redis came out 20–35× faster under contention both times. Between the two Postgres-only
strategies, pessimistic was 15–18% slower without contention in both runs (its extra round
trip). In the first run it also beat conditional in the hot row; the second run showed them
equal (158 vs 157 ms), so that was noise.

## Decision

- **Postgres is the only authority on seat ownership,** in every strategy. A seat changes owner
  only through the hold transaction's update on its own `show_seats` row.
- **`redis` is the default** (`HOLD_STRATEGY=redis`): a Redis filter in front of the
  conditional update. `conditional` and `pessimistic` stay available and stay tested.
- **Redis filters, it never decides.** A Redis lock can disappear (failover, eviction, a TTL that
  runs out during a long pause), so two requests might both pass it; the conditional update
  behind it still lets only one win. If Redis is unreachable, requests skip the filter and are
  still correct, only slower under contention.
- **The Redis lock lives only for the transaction** (milliseconds). The 5-minute hold lives only
  in Postgres (`held_until`), so there is no second copy of hold state to keep in sync.
- **Every strategy locks rows in id order,** so overlapping multi-seat requests cannot deadlock.

## Consequences

- Hot shows stay fast: buyers who cannot win are answered in milliseconds without touching the
  database, which protects the connection pool for buyers who can.
- Redis was already required (sessions), so the default adds no new infrastructure. Losing Redis
  costs speed under contention, never correctness; a test proves holds stay correct with Redis
  down.
- The concurrency suite runs against all three strategies, so the alternatives cannot rot and
  the default can be switched back with one setting.
- The decision is revisited in M7, when load tests go through nginx and real HTTP.
