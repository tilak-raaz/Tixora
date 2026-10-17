# 0016. Load tests: k6 next to the stack, one visitor per address, each scenario asserts a rule

- Status: Accepted
- Date: 2026-10-17

## Context

The M2 benchmark (`make bench`) measured the seat-hold strategies by calling the service in one
process. M7 asks different questions, about the whole deployed shape behind nginx (ADR 0014):

1. What do 3 replicas buy over 1 for ordinary browsing, on one machine?
2. Under a real storm of buyers through nginx and three replicas, does every seat still get
   exactly one owner, and how are the losers turned away?
3. When hundreds of people watch one seat map, how long does a hold take to reach all of them,
   and are the streams spread across replicas?
4. Is a per-IP limit really one limit across all replicas, not one per replica?

A load generator on the host would send everything from one address. The per-IP limits (browse:
120 a minute, ADR 0010) would throttle it after a few seconds and the test would measure the rate
limiter, not the system. Turning the limits off for load tests would measure a configuration
nobody runs.

## Decision

- **k6 runs in a container on the stack's network** (`make load-*`), so nothing is installed on
  the host and the scripts are versioned with the code (`infra/load/`).
- **One visitor per address.** The scenarios call nginx's internal port (8081), the one the
  Next.js server uses, which passes `X-Forwarded-For` through. Each simulated visitor sends its
  own made-up address from 10.0.0.0/8, so the per-IP limits stay on and apply to each visitor, as
  they would for that many real people. The rate-limit scenario is the exception: it goes through
  the public edge (8080) as a single address, because that is the case it tests.
- **Every scenario asserts its rule as a k6 threshold**, so a run that is fast but wrong fails:

  | Scenario                           | Asserts                                                           |
  | ---------------------------------- | ----------------------------------------------------------------- |
  | `browse.js` (`load-browse`)        | under 1% errors, p95 under 500 ms                                 |
  | `seat-storm.js` (`load-storm`)     | exactly SEATS holds won, every other buyer a clean 409, no errors |
  | `fanout.mjs` (`load-fanout`)       | every viewer hears every change (exit code 1 otherwise)           |
  | `rate-limit.js` (`load-ratelimit`) | exactly 5 sign-in attempts answered and 25 limited                |

- **The fan-out test is plain Node.js**, because k6 has no Server-Sent Events client without a
  custom build. It measures from the buyer pressing Hold to each viewer hearing it, and reads each
  replica's open-stream count from `/metrics` while the streams are open.
- **1 versus 3 replicas** is the same browse run after `make stack-scale N=1`, both as people
  browse (about a second between clicks) and as a capacity run with no pauses (`THINK=0`), the
  only one that can show what extra replicas add.
- Results go to `docs/benchmarks/m7-load.md` with the machine they ran on, and
  `make stack-metrics` after each run shows where the load landed.

## Consequences

- The tests exercise the real proxy, the real limits and the real cross-replica paths (Redis
  pub/sub, the shared limiter, Postgres row locks), not a stripped-down copy.
- Traffic enters at the internal port, so the public edge's own work (dropping the client's
  `X-Forwarded-For`, gzip) is not in the browse numbers; it is the same nginx process doing the
  same proxying, so the difference is small.
- Load generator, proxy, replicas and databases share one laptop: the numbers compare
  configurations with each other, they are not capacity figures. A replica count that helps here
  is limited by the machine's cores, not by the design.
- Each run signs up new users and leaves the storm's winning holds to expire; the local database
  grows a little with every run (`make reset` clears it).
