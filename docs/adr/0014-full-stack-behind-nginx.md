# 0014. Run the app as containers behind one nginx, with least-connections balancing

- Status: Accepted
- Date: 2026-10-17

## Context

Until M6 the app ran only on the host (`make dev-*`), one process each. The design claims more:
the API is stateless, so any number of replicas can serve any request (sessions, rate limits,
the cache and seat events all live in Redis or Postgres), and workers can be added freely
because queue consumers are idempotent. M7 has to show that, measure it and break it on purpose,
which needs a production-like stack that starts with one command.

Decisions this needed:

- **How the servers run in a container.** Compile with `tsc` and run JavaScript, or run the
  TypeScript through tsx as in development. The packages use bundler-style imports without file
  extensions, which plain `node` cannot load after `tsc`; a bundler would be another build to keep
  in step with what the tests run.
- **How requests are spread.** nginx's default is round-robin. Live seat maps keep a connection
  open for as long as the page is open (ADR 0013), so equal request counts do not mean equal load.
- **How migrations run.** Each replica migrating at startup means three processes racing for the
  same lock, and a replica that starts against an older schema if the order goes wrong.
- **Who the client is.** Rate limits are per IP (ADR 0010), and the API trusts exactly one proxy
  hop. Server rendering adds a second hop: browser → nginx → Next.js → API.

## Decision

A `full` profile in `infra/docker-compose.yml` (`make stack`) runs nginx, 3 API replicas, 2
workers, the Next.js server and a one-shot `migrate` job, against the same Postgres, Redis and
Mailpit as `make up`. http://localhost:8080 is the only published app port.

- **Images.** One server image (`infra/docker/server.Dockerfile`) for the API, the worker and the
  migrate/seed scripts, with production dependencies only; tsx is one of them. It starts with
  `node --import tsx`, so Node is the main process and receives SIGTERM itself. The web image is
  Next.js's standalone output (`infra/docker/web.Dockerfile`).
- **Balancing.** `least_conn`: each request goes to the replica with the fewest open
  connections, which counts open seat streams. The upstream is the service name `api` with
  `resolve`, so nginx follows Docker's DNS as replicas stop, come back with new addresses or are
  scaled. A replica that fails 3 times is skipped for 10 s; a request that could not reach a
  replica is retried once on another, never for POST, PATCH or DELETE.
- **Seat streams.** Unbuffered with a 60 s read timeout; the API's 15 s heartbeat keeps a healthy
  stream well inside it.
- **Migrations.** The `migrate` job runs once; replicas and workers start only after it exits
  successfully (`service_completed_successfully`).
- **Client address.** The public port (8080) sets `X-Forwarded-For` to the address nginx sees,
  dropping whatever the client sent. Server rendering calls the API through a second, internal
  port (8081) that passes on the address Next.js received, so those requests are balanced too and
  still count against the visitor's own limits.
- **Production by default.** The containers run with `NODE_ENV=production`, where fake payments
  are refused. `make stack DEMO=1` layers `infra/docker-compose.demo.yml` (`NODE_ENV=test`,
  `PAYMENT_GATEWAY=fake`) for the browser demo and the Playwright run through nginx.

## Consequences

- One command gives a stack that behaves like the deployment: the same images, the same proxy
  rules, migrations before traffic. CI builds it and runs the Playwright suite through nginx, so
  the images, the proxy config and the forwarded-address chain are tested on every PR.
- tsx compiles each file when it is first loaded, which adds a little to startup (a second or
  two) and nothing per request after that.
- Everything runs on one machine, so 3 replicas show how load spreads and what happens when one
  fails, not more total capacity than the machine has.
- nginx is now the one component everything goes through. Running two of them, or a managed load
  balancer, is outside this project; the deployment (M8) keeps one.
- Free nginx notices a broken replica only when real requests to it fail; it does not probe them
  in the background. The failure drills measure what users see during that window.
- The demo override exists so that fake payments never need `NODE_ENV=production` to allow them.
