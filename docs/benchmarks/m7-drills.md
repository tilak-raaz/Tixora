# M7 failure drills: breaking the stack under traffic

Run on 2026-10-17 with `make drill-*` ([ADR 0017](../adr/0017-failure-drills.md)) against the full
stack (`make stack DEMO=1`): nginx, 3 API replicas, 2 workers, Postgres, Redis. Same machine as the
[load tests](m7-load.md).

During every drill a probe plays steady users for 60 to 75 seconds:

- about 38 reads a second (a seat map from Postgres, the city list from the cache);
- a hold or release of one seat every second, taking turns among 6 signed-in buyers;
- a wrong-password sign-in every second;
- 60 live seat maps that reconnect like a browser and reload when they do.

A drill fails if any viewer ends up showing a seat state different from the database (or, for the
worker drill, if an email is lost).

The first run broke the predictions in four places. Each finding was traced in the logs, fixed with
a regression test that fails without the fix, and the drill was run again. Both runs are below.

## Results after the fixes

| Drill            | What broke                                              | Reads failed                | Signed-in actions                                    | Live seat maps                                                      | Recovery                                                          |
| ---------------- | ------------------------------------------------------- | --------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Replica crash    | SIGKILL to the API process in one of 3 replicas         | 0 of 2,271                  | 29 holds, all 201                                    | 20 viewers on it reconnected once; 60/60 right                      | Docker restarted it; healthy 5 s after the crash                  |
| Replica stopped  | `docker stop` (SIGTERM, drain)                          | 0 of 2,279                  | 29 holds, all 201                                    | 20 reconnects (one each); 60/60 right                               | started again at 35 s, healthy 6 s later                          |
| Redis down 30 s  | Redis container stopped                                 | 0 of 2,836                  | 35 holds, all 201 (about 1 s each during the outage) | no stream dropped; all 60 resynced when Redis returned; 60/60 right | none needed; sign-in refused (503) while down, as designed        |
| Postgres restart | Postgres container restarted                            | 7 of 2,285, all in 1 second | 29 holds, all 201                                    | no stream dropped; 60/60 right                                      | pools reconnected by themselves, no API restart                   |
| Worker killed    | one of 2 workers killed 2 s after 20 bookings were paid | –                           | 20 bookings confirmed                                | –                                                                   | 20 of 20 emails delivered, 0 lost, 0 duplicated, all within 3.7 s |

## Predictions against the first run

| Drill            | Predicted (ADR 0017)                   | First run                                                                                                                | Cause                                                                                                                                                                                                | Fix                                                                                                                                                                 |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Replica crash    | nginx retries; its viewers reconnect   | As predicted (0 reads failed)                                                                                            | –                                                                                                                                                                                                    | –                                                                                                                                                                   |
| Replica stopped  | in-flight requests finish              | Reads fine, but the 20 viewers reconnected **200** times, and the replica was force-killed after its 10 s shutdown limit | nginx kept reusing kept-alive connections to the draining replica, which answered new seat streams by ending them at once, and never finished draining                                               | A draining replica answers `Connection: close` and refuses new streams with 503; nginx retries that 503 on another replica                                          |
| Redis down       | holds keep working (Postgres decides)  | Holds failed: `500` ×7, timeouts ×3, then 409s for the rest of the run                                                   | (1) "Failed to get session": a Redis error was thrown, although every session is also in Postgres. (2) The seat pre-lock had no time limit, so a live Redis client queued it and retried for seconds | (1) Session reads fall back to Postgres within 250 ms. (2) The pre-lock is skipped when Redis is not connected and capped at 200 ms otherwise                       |
| Postgres restart | a few seconds of errors, then recovery | 19 reads failed over 2 s, as predicted, but **one worker crashed and stayed down**                                       | A connection cut while checked out mid-transaction emitted an error nobody listened to: an uncaught exception. No restart policy, so nothing brought it back                                         | Every pooled connection gets an error listener; app containers restart on failure                                                                                   |
| Worker killed    | the other worker takes over            | 15 of 20 emails stuck                                                                                                    | There was no other worker: the Postgres drill had killed it                                                                                                                                          | Fixed by the two above. The first run's logs still showed the takeover working: once a worker was back, the 5 jobs the killed one held were marked stalled and sent |

Each fix has a regression test that was run without the fix first, to be sure it catches the bug:

- `db-connection-loss.test.ts` fails with the worker's exact uncaught exception.
- `hold-strategies.test.ts` hangs on a Redis that accepts connections but never answers.
- `session-redis-down.test.ts` checks that a signed-in user still works without Redis.
- `seat-events.test.ts` checks that a draining replica sends viewers elsewhere.

## Known limits

- **Sign-out during a Redis outage.** Better Auth deletes the Redis copy first; that fails, so the
  Postgres row is not deleted either, but sign-out still answers 200 and clears the cookie. The user
  is signed out in their browser, but the session stays valid until it expires, so a copy of the
  cookie taken earlier would still work. Closing this needs a revocation list checked on every
  request; that is not worth it for a Redis outage plus a stolen cookie. A test pins the behaviour.
- **Sign-in is refused while Redis is down**, on purpose: the password-guessing limit fails closed
  (ADR 0010).
- **Duplicate emails over SMTP** stay possible if a worker dies between sending and recording (ADR
  0009); none happened here. Production sends through Resend, which deduplicates by the outbox id.
- One machine, containers only: a dead container is not a lost host, and network partitions are not
  covered.
