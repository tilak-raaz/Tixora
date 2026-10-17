# M7 load tests: the stack behind nginx

Run on 2026-10-17 with `make load-*` against the full stack (`make stack DEMO=1`): nginx, 3 API
replicas (unless stated), 2 workers, Postgres and Redis. Each scenario asserts its own rule and
fails the run if it breaks ([ADR 0016](../adr/0016-load-testing.md)). Per-IP limits stayed on:
every simulated visitor had its own address.

- **Machine:** Apple M1 (8 cores), 8 GB RAM. Docker's VM: 8 CPUs, 3.8 GiB. The load generator,
  nginx, the replicas and both databases all share it, so compare the rows with each other; they
  are not capacity figures.
- **Software:** k6 1.0.0, nginx 1.28, Node.js 24 (tsx), PostgreSQL 17, Redis 7.
- Latencies are measured by k6, so they include nginx. "Server" figures come from the replicas'
  own metrics (`make stack-metrics`).

## Seat storm: 200 buyers, 10 seats, at the same moment

`make load-storm`: 20 buyers per seat, every request fired at once, spread over 3 replicas.

| Holds won | Refused (clean 409) | Errors | Turned away by the Redis pre-lock | Turned away by Postgres | Hold p50 | Hold p95 |
| --------: | ------------------: | -----: | --------------------------------: | ----------------------: | -------: | -------: |
|        10 |                 190 |      0 |                         150 (79%) |                40 (21%) |   395 ms |   477 ms |

Every seat ended with exactly one owner, and every contested seat shows as taken afterwards. Four
in five losers never opened a Postgres transaction. The hold time is the whole HTTP path (nginx,
session check, idempotency key, the hold, the seat event) with 200 requests landing in the same
instant on a laptop, so it is higher than the M2 benchmark's in-process 7 ms
([m2-hold-strategies.md](m2-hold-strategies.md)). The 10 winning holds expired by themselves 5
minutes later.

## Hot show: 300 people watching one seat map

`make load-fanout`: 300 open live seat maps on one show, then a buyer holds and releases a seat 10
times. Times run from the buyer pressing Hold (or Release) until each viewer's map hears about it.

| Open streams per replica | Changes heard  | p50   | p95    | p99    | Slowest |
| ------------------------ | -------------- | ----- | ------ | ------ | ------- |
| 100 / 100 / 100          | 3,000 of 3,000 | 35 ms | 108 ms | 125 ms | 128 ms  |

nginx's least-connections balancing split the streams exactly evenly (ADR 0014). All 300 opened in
879 ms. The slowest change was the first hold (p50 108 ms); after that every change reached all 300
viewers within 64 ms. A viewer on one replica hears about a hold made on another through Redis
pub/sub (ADR 0013).

## Rate limit across replicas

`make load-ratelimit`: one address tries to sign in every half second, 30 times, through the
public edge, so nginx spreads the attempts over all 3 replicas.

| Attempts | Answered (401) | Limited (429) | Limited attempts' median time |
| -------: | -------------: | ------------: | ----------------------------: |
|       30 |              5 |            25 |                         ~5 ms |

Exactly the 5 a minute the policy allows, not 5 per replica: the count lives in Redis (ADR 0010).
Refusing is cheap, while a real sign-in attempt checks a password hash and costs hundreds of
milliseconds, so the limiter also protects the API's CPU from password guessing.

## Browsing: 1 replica against 3

`make load-browse`, home page → a movie → its shows → a show → its seat map. Each visit comes from
a new address. Run twice: as people browse (0.3 to 0.7 s between clicks, ramping to 100 at once)
and as a capacity test (no pauses, 50 at once). The single-replica runs used
`make stack-scale N=1`.

### As people browse (100 visitors, about 200 requests a second)

| Replicas | Requests | Errors | p50    | p95    | p99    | Slowest |
| -------: | -------: | -----: | ------ | ------ | ------ | ------- |
|        3 |   27,588 |      0 | 1.6 ms | 8.6 ms | 44 ms  | 578 ms  |
|        1 |   26,166 |      0 | 2.3 ms | 33 ms  | 497 ms | 2.1 s   |

At this load either setup copes, and the typical request barely changes. The tail does: with one
replica, p99 is 11 times worse. One Node.js process runs its JavaScript on one thread, so a burst
queues behind whatever that thread is doing; three replicas mean three queues, and bursts stay
short. The 3-replica requests split 9,361 / 9,373 / 9,435.

### Capacity (50 visitors, no pauses)

| Replicas | Requests a second | p50   | p95   | p99   | Server CPU (cores)         |
| -------: | ----------------: | ----- | ----- | ----- | -------------------------- |
|        3 |             1,586 | 17 ms | 52 ms | 88 ms | 0.7 per replica, 2.1 total |
|        1 |             1,206 | 27 ms | 56 ms | 82 ms | 1.0                        |

No errors in either run. Three replicas served 32% more requests a second with a 37% lower median,
not three times as many. The single replica sat at one full core, the limit of its one JavaScript
thread. With three, each replica was busy only about 70% of the time: the API had stopped being the
bottleneck, and the rest of the machine (k6 parsing 645 MB of responses, nginx, Postgres for the
uncached seat maps, all on the same 8 CPUs) set the ceiling instead. On separate machines the
replicas would keep scaling until the database became the limit; on one laptop, scaling out is
worth exactly what the spare cores allow.

## What this shows

- Correctness held under load through the real deployment shape: one owner per seat, one limit
  across replicas, every live update delivered.
- The Redis pre-lock does its job under a real storm: most losers are turned away before they cost
  Postgres a transaction.
- More replicas first buy a steadier tail, then throughput, and only until the next bottleneck.
