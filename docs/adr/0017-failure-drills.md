# 0017. Failure drills: break the running stack under traffic, predict first, check what users saw

- Status: Accepted
- Date: 2026-10-17

## Context

The integration tests already break things in-process: Redis pointing at a dead port, a worker
child process killed with SIGKILL mid-batch (M4, M5). They prove the code paths. They cannot show
what a user notices when a whole container dies behind nginx: how many requests fail and for how
long, whether live seat maps come back by themselves and show the right seats, whether a restarted
database is picked up without restarting the API.

## Decision

`make drill-*` (`infra/drills/run.sh`) breaks one part of the full stack (ADR 0014) while a probe
plays steady users, then puts it back:

| Drill            | What breaks, when                                                                           | Predicted before running                                                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drill-replica`  | an API replica is killed (SIGKILL) at 15 s, back at 35 s; `MODE=stop` sends SIGTERM instead | Reads barely notice: nginx retries a failed connection on another replica. Requests already inside the killed replica fail. Its viewers reconnect to the others within a couple of seconds and reload. With SIGTERM, in-flight requests finish.   |
| `drill-redis`    | Redis stopped at 15 s, started at 45 s                                                      | Reads and holds keep working (the cache, the browse limit and the hold pre-lock fail open; Postgres decides seats). Sign-in is refused with 503 (that limit fails closed). Live updates stop; viewers get `resync` when the subscription returns. |
| `drill-postgres` | Postgres restarted at 15 s                                                                  | Requests that need Postgres fail for a few seconds, then recover with no API restart: the pools drop dead connections and open new ones.                                                                                                          |
| `drill-worker`   | one of two workers killed while 20 confirmation emails go out                               | No email lost: jobs the dead worker held are taken over by the other when their lock expires (30 s). Over SMTP an email can repeat if the kill lands between sending and recording (ADR 0009).                                                    |

The probe (`probe.mjs`) sends reads (a seat map from Postgres, the city list from the cache), has a
buyer hold and release a seat every second, tries a sign-in every second, and keeps live seat maps
open that reconnect like the browser does. It prints one line per second. A drill **fails** if,
at the end, any viewer shows a seat state different from the database: an outage may cost
requests, but it must not leave anyone looking at a wrong seat map. The worker drill fails if any
email is lost.

Results, compared with the predictions, go to `docs/benchmarks/m7-drills.md`; surprises go to
`docs/lessons.md`.

## Consequences

- Each failure mode has a repeatable, one-command demonstration with numbers, which is also how a
  regression in recovery behaviour would be noticed.
- The drills run on one machine with Docker: "a replica dies" is a container killed, not a host
  lost, and network partitions are not covered.
- They change shared local state (they create users and bookings, and restart containers), so
  they are for the local stack only, never a deployed one.
