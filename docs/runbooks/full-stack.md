# Full stack (containers behind nginx)

The app in containers, production-like: nginx at http://localhost:8080 in front of 3 API
replicas, 2 workers and the Next.js server. Why it is built this way: [ADR 0014](../adr/0014-full-stack-behind-nginx.md).

```text
browser ──▶ nginx :8080 ─┬─ /api/*, /webhooks/* ──▶ api ×3 (least connections)
                         └─ everything else ─────▶ web ──▶ nginx :8081 (internal) ──▶ api ×3
```

It shares Postgres, Redis and Mailpit with `make up`, so the data you seeded for development is
there too. You can keep `make dev-*` running beside it; the stack publishes only port 8080.

## Start it

```bash
make stack DEMO=1   # builds the images, runs migrations, starts everything, waits until healthy
make stack-seed     # only on an empty database (does nothing if already seeded)
open http://localhost:8080
```

- `DEMO=1` turns on fake payments (the Pay / Fail sheet). Without it the containers run as
  production, where fake payments are refused; payments then need Razorpay test keys exported in
  your shell (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`), or they
  answer 503.
- The first build takes a few minutes; later ones reuse the cached layers.
- After changing code, run `make stack` again: it rebuilds and replaces only what changed.

## Look at it

| Command           | Shows                                                                |
| ----------------- | -------------------------------------------------------------------- |
| `make stack-ps`   | every container and its health                                       |
| `make stack-logs` | logs; nginx's JSON lines name the replica that answered (`upstream`) |
| `make psql`       | the shared database                                                  |

To see requests spread across the replicas:

```bash
for i in $(seq 1 9); do curl -s -o /dev/null http://localhost:8080/api/v1/cities; done
docker compose -f infra/docker-compose.yml --profile full logs nginx | grep '/api/v1/cities' | tail -9
```

The `upstream` field cycles through three addresses. An API log line's `hostname` is the
container ID shown by `make stack-ps`.

## Browser tests through nginx

```bash
make stack-e2e
```

Starts the stack with fake payments and rate limits off (every test signs up a new user), seeds
it, waits until it answers at normal speed (`make stack-warm`), and runs the Playwright suite
against http://localhost:8080. The stack stays up with rate
limits off afterwards; `make stack DEMO=1` turns them back on. CI runs the same steps.

## Stop it

```bash
make stack-down   # removes the app containers; Postgres, Redis and data stay
make down         # stops everything, the stack included
```

## Troubleshooting

- **`make stack` times out waiting.** `make stack-ps` shows which container is unhealthy;
  `make stack-logs` shows why. A failed `migrate` stops everything after it.
- **502 from nginx.** No replica answered. Check `make stack-ps`; the API replicas need Postgres
  and Redis healthy before they report ready.
- **Port 8080 in use.** Stop whatever holds it, or change the published port in
  `infra/docker-compose.yml` together with `BETTER_AUTH_URL` and `WEB_ORIGINS`.
