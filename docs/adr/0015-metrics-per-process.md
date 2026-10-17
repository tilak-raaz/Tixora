# 0015. Each process serves its own Prometheus metrics; no monitoring stack yet

- Status: Accepted
- Date: 2026-10-17

## Context

M7 puts 3 API replicas and 2 workers behind nginx, loads them with k6 and breaks them on purpose.
Logs say what happened to one request; they cannot say how load spread across replicas, how
latency moved under load, or whether the database pool or the event loop was the bottleneck.

Options considered:

- **Push metrics to a hosted service.** Needs an account and a network path out of the stack, and
  ties the project to a vendor.
- **Prometheus and Grafana in the compose stack.** The usual answer, but two more services to run
  and dashboards to keep in step, mostly to draw graphs that a load run's summary already gives.
- **Each process serves `/metrics` in the Prometheus text format, and nothing scrapes it yet.**
  The format is the standard one every monitoring stack reads, so adding Prometheus later changes
  no application code.

## Decision

The client is `@prometheus-io/client`, the Prometheus organisation's Node.js client (the
continuation of `prom-client`). Every API replica serves `GET /metrics` on its own port; every
worker runs a small server on `METRICS_PORT` (9100) with `GET /metrics` and `GET /healthz`, which
is also its Docker health check. Each series carries `service` and `instance` labels. nginx
forwards only `/api` and `/webhooks`, so the metrics are reachable only from inside the stack.
`make stack-metrics` reads every replica from inside its container and prints them side by side.

What is measured, chosen for the questions M7 asks:

| Metric                                                                               | Answers                                                                                                 |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `bmt_http_request_duration_seconds{method,route,status}`                             | load split, latency, 4xx/429/5xx per replica                                                            |
| `bmt_holds_total{outcome}`                                                           | how contention ends: held, rejected early by the Redis pre-lock, seat taken in Postgres, refused, error |
| `bmt_seat_streams`, `bmt_seat_stream_shows`                                          | how least-connections spread the live seat maps                                                         |
| `bmt_db_pool_connections{state}`, `bmt_db_pool_waiting_queries`                      | whether the pool is the bottleneck                                                                      |
| `bmt_jobs_total{queue,result}`, `bmt_job_duration_seconds{queue}`                    | work done per worker, failed attempts                                                                   |
| `bmt_queue_jobs{queue,state}`, `bmt_outbox_unpublished`, `bmt_outbox_oldest_seconds` | backlog (read at scrape time)                                                                           |
| Client defaults                                                                      | CPU, memory, event loop lag, GC                                                                         |

Rules that keep it cheap and honest:

- **Route labels are patterns**, such as `/api/v1/bookings/:id`, never raw paths. Requests that
  matched no route share `unmatched`, so a scanner cannot create series without end.
- **Seat streams are not timed**: they stay open for minutes and would swamp every latency number;
  the open-stream gauge covers them. Health checks and `/metrics` itself are not timed either.
- **Counts per process, never aggregated in the app.** A slow replica stays visible.
- Queue depth and outbox lag are read from Redis and Postgres when scraped, so every worker
  reports the same values; a scrape while Redis is down still returns everything else.

## Consequences

- k6 runs and failure drills can show where load went and what each replica felt, from one
  command, with no extra services.
- Nothing keeps history: numbers are totals since each process started, and a restarted replica
  starts from zero. Comparing before and after means reading twice. When history is needed (the
  deployment, M8, or later), Prometheus can scrape these endpoints as they are.
- Every request pays for one histogram update; at this scale it does not show in latency.
