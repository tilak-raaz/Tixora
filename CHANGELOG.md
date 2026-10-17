# Changelog

All notable changes are recorded here, one section per release tag.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions: [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Production stack (ADR 0018): `infra/deploy/docker-compose.yml` runs the CI-built images from GHCR on one server, with Postgres and Redis in containers, `API_REPLICAS` and `WORKER_REPLICAS` settings, Resend for email and Razorpay in test mode. Container logs are capped
- HTTPS: nginx serves only ports 80 (ACME challenge, redirect) and 443 (TLS 1.2/1.3, HTTP/2, HSTS) with a Let's Encrypt certificate; a certbot container renews it and nginx reloads twice a day
- `infra/deploy/tixora.sh` on the server: `tls-init` for the first certificate, `deploy <tag>` to check out a release, pull its images and start it, plus `seed`, `ps`, `logs` and `down`
- `infra/deploy/.env.example`: every production setting; the real `.env` stays on the server
- `make deploy-check` and a CI step: the production compose file resolves, and nginx accepts the HTTPS config

### Changed

- `make seed` tops up: on an existing database it adds the coming week's shows instead of stopping, so the deployed stack runs it daily and never runs out of shows
- nginx config split into shared pieces (`infra/nginx/http.conf`, `routes.conf`, `internal.conf`) used by both the local stack and production

## [0.8.0] - 2026-10-17

M7: the app as a production-like stack of containers behind nginx, measured under load and broken on purpose.

### Added

- Full stack in containers (ADR 0014): `make stack` starts nginx at http://localhost:8080 in front of 3 API replicas, 2 workers and the Next.js server, after a one-shot `migrate` job, on the same Postgres and Redis as `make up`. `DEMO=1` adds fake payments; otherwise the containers run as production
- nginx: `least_conn` across the replicas found through Docker's DNS (so seat streams count and restarted replicas are followed), unbuffered seat streams, a request ID passed to the API, JSON access logs naming the replica, the client address set at the edge and carried through server rendering on an internal port
- Images: one server image for the API, worker and scripts (production dependencies, run through tsx), and the web app as a Next.js standalone server
- `make stack-e2e` and a CI job: the Playwright suite through nginx against the built images
- `make stack-warm` (`infra/scripts/warm-up.sh`): waits until the stack answers at normal speed, not just healthy, before tests and load runs
- Web: `/healthz` for the container health check
- Metrics (ADR 0015): every API replica serves `GET /metrics` and every worker serves it on `METRICS_PORT` (9100, also its health check), in the Prometheus text format with `service` and `instance` labels. Request latency by route pattern and status, hold outcomes (held, rejected early by the Redis pre-lock, seat taken in Postgres, refused, error), open seat streams, the Postgres pool, jobs per queue, queue depth and outbox lag, and Node's own (CPU, memory, event loop lag). nginx does not route them
- `make stack-metrics` (`ROUTES=1` for the busiest routes): every replica's and worker's numbers side by side, read from inside the containers
- Load tests (ADR 0016), run with k6 in a container on the stack's network: `make load-browse` (visitors browsing, ramping to `VUS`), `make load-storm` (`BUYERS` grab `SEATS` seats at once; exactly `SEATS` may win), `make load-fanout` (`VIEWERS` watch one seat map; time for each hold to reach all of them; a Node.js script, as k6 has no SSE client) and `make load-ratelimit` (one address hammers sign-in across all replicas; exactly 5 may pass). Each simulated visitor has its own address, so per-IP limits stay on; each scenario fails if its rule breaks
- `make stack-scale N=1`: run a different number of API replicas behind nginx
- Failure drills (ADR 0017): `make drill-replica` (`MODE=stop` for SIGTERM), `make drill-redis`, `make drill-postgres` and `make drill-worker` break one part of the full stack while a probe plays steady users (reads, a buyer, sign-ins, live seat maps that reconnect like a browser), then put it back. A drill fails if any viewer ends up showing the wrong seat state, or (worker drill) any confirmation email is lost

### Changed

- `make down` and `make reset` also stop the full stack's containers
- App containers in the full stack (API, worker, web, nginx) restart when they crash

### Fixed

Found by the failure drills (`docs/benchmarks/m7-drills.md`), each with a regression test:

- A Postgres connection cut while checked out (a database restart mid-transaction) crashed the process with an uncaught exception; every pooled connection now has an error listener, so the work fails and is retried instead
- With Redis down, every signed-in request failed ("Failed to get session"); sessions are now read from Postgres when Redis errors or takes longer than 250 ms
- With Redis down, holds waited seconds for the seat pre-lock; it is now skipped when Redis is not connected and limited to 200 ms otherwise
- A replica shutting down kept taking new live seat streams over nginx's kept-alive connections and ended each at once, so viewers reconnected over and over and the shutdown timed out; a draining replica now answers `Connection: close` and refuses new streams with 503, which nginx retries on another replica

## [0.7.0] - 2026-10-17

M6: the web app, with live seat maps.

### Added

- `apps/web`: Next.js (App Router) frontend (ADR 0012). The browser only talks to its own origin: `/api/*` is forwarded to the API, so the session cookie is first-party and there is no CORS. A typed `api()` client turns every error response into an `ApiError` with the API's code and `Retry-After`
- Design: everything is a ticket. Movie cards, dates and show times have perforated tear lines and notched stubs; the show page, checkout and ticket open on a ticket in the movie's poster colour; Anton for headlines and poster titles, Schibsted Grotesk for text, red only for actions and selection; typographic posters for movies without an image
- Browse: what is showing in a city by date (city in the header, remembered in a cookie), a movie with its shows by theatre, a show's details; times always in the city's time zone; sign up and sign in that return to the page you came from (same-site paths only)
- Seat map: screen at the top, a price heading per category, aisles as gaps; pick up to 5 seats and hold them; a hold already open, seats just taken, rate limits and signing in first (picks come back) are each handled
- Live seat maps (ADR 0013): `GET /api/v1/shows/:id/seats/events` streams seat changes as Server-Sent Events. Every seat change (hold, release, expiry by job, sweeper or a new hold, payment confirmed by webhook or reconciler) publishes the seats' state after it commits on the show's Redis channel; each replica subscribes once per watched show and forwards to its viewers. The browser merges events and the snapshot by seat version; the 15 s heartbeat carries the show's seat version, so a lost event is noticed and the map reloads; a reconnected subscriber tells viewers to resync. Opening a stream counts against the browse limit, and a replica keeps at most 6 streams per IP
- Checkout: the held seats with a 5:00 countdown (red in the last minute), Release seats, and Pay: Razorpay Checkout, then a signature check and "Confirming your booking" until the webhook confirms it (up to 30 s), then the ticket. A payment after the hold ended explains the automatic refund
- Fake payment mode (`PAYMENT_GATEWAY=fake`, refused in production): a test sheet with Pay and Fail that answers like Checkout and sends a signed webhook through the real handler a moment later, so bookings are still confirmed only by the webhook. The worker sends no refunds in this mode
- Ticket page (`/bookings/:id`) with the booking reference and the PDF, and My bookings (`/bookings`): waiting for payment, coming up, watched, not booked; `GET /api/v1/bookings` behind it
- Server-rendered pages pass the visitor's address on in `X-Forwarded-For` (last proxy entry only), so per-IP limits stay per visitor
- `make dev-web`, `make build-web` and `make e2e`; CI builds the web app and runs the browser tests
- Tests: 12 integration tests for live seats across two replicas and a worker (a hold on one replica seen on the other within a second, worker expiry reaching both, a lost event exposed by the heartbeat, resync after the subscriber connection is killed, the stream limit, the publisher surviving an unreachable Redis); fake payments, My bookings; unit tests for the seat-map state (merge by version, heartbeat gap detection), dates and the API client; 4 Playwright tests (the whole journey to the ticket, two browsers watching each other's holds, a failed payment, a hold that runs out)
- README screenshots

### Changed

- The seat map includes each seat's `version`; it and the seat events share one definition of a free seat
- Razorpay webhook handling is one function, used by the route and by the fake payment mode

### Removed

- `/dev/checkout`: the web app replaces it

## [0.6.0] - 2026-10-16

M5: rate limiting and caching.

### Added

- Distributed rate limiting (ADR 0010): each check is one Lua script in Redis using Redis's own clock, so every replica shares one budget per key
- Token bucket for holds (10/min per user), payment orders (5/min per user) and public browsing (120/min per IP); sliding window log for sign-in and sign-up (5/min per IP, exact)
- `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers; `429 RATE_LIMITED` with `Retry-After`; webhooks are never limited
- When Redis is down: sign-in and sign-up refuse with 503 (fail closed); every other route stays open
- Setting `RATE_LIMIT_ENABLED` (default true)
- Tests: bucket burst, refill and per-subject budgets, 50 simultaneous checks against a capacity of 10, sliding-window edges, both failure modes, and three replicas allowing exactly 10 of 30 holds
- Catalog cache (ADR 0011): cities, movies in a city, a movie, a movie's shows and a show are read through Redis for 60 s, with `X-Cache: HIT | MISS | BYPASS`; the seat map is never cached
- Invalidation by version: every admin catalog write increments the catalog version before answering, so every replica's next read is fresh; nothing has to be found and deleted
- Concurrent misses for one key load it once per replica; Redis down or slower than 100 ms falls back to Postgres
- Setting `CATALOG_CACHE_TTL_SECONDS` (default 60, 0 turns the cache off)
- Tests: hit after miss, TTL expiry, seat map and 404s never cached, an admin write on one replica seen on another, a refused write leaving the cache alone, 20 concurrent misses loading once, Redis down and Redis slow

## [0.5.0] - 2026-10-16

M4: async processing.

### Added

- Transactional outbox (ADR 0008): `0007_outbox.sql` adds `outbox` and `processed_messages`; confirming a booking writes `booking.confirmed` and recording a refund writes `refund.recorded`, in the same transaction, with the HTTP request id
- Outbox relay in the worker: locks unpublished events with `FOR UPDATE SKIP LOCKED`, queues each to its queues under the outbox id as the job id, and marks it published; several relays split the work, and a relay that dies mid-batch causes no duplicate job
- Worker setting `OUTBOX_RELAY_INTERVAL_MS` (default 500)
- `email` queue; `refund.recorded` feeds both the refund queue and the email queue
- Emails (ADR 0009): "Booking confirmed" (show, seats, total, reference) and "Refund on its way" (amount and the reason in plain words), read from Postgres when sent, with names escaped in HTML
- `Mailer` with three implementations: SMTP via Nodemailer to Mailpit in development, Resend's HTTP API in production, and a fake for tests
- Each email is sent once per event: `processed_messages` skips finished messages, and the outbox id is the provider's idempotency key, so a send repeated after a crash is dropped
- Worker settings `MAILER`, `SMTP_URL`, `RESEND_API_KEY`, `EMAIL_FROM`
- PDF ticket (A6, QR code with the booking id, show, seats, amount, reference), rendered from the booking with PDFKit and attached to the confirmation email; never stored, so it always matches the booking
- `GET /api/v1/bookings/:id/ticket`: the ticket for the owner of a confirmed booking (409 `BOOKING_NOT_CONFIRMED` otherwise, 404 for anyone else's)
- Dead letter queue: failed jobs stay in each queue's failed set; `make replay-dlq QUEUE=email [DRY=1]` lists them with the reason and request id, and moves them back to waiting once the cause is fixed
- Failure drill: an email worker in its own process is killed with `SIGKILL` mid-batch; the worker that takes over (after the stalled-job check) delivers every email, and none twice
- Tests: rolled-back changes leave no event; two relays at once queue each event exactly once; a relay killed between queuing and committing leaves one job; events survive a Redis outage
- [docs/runbooks/queues.md](docs/runbooks/queues.md): following a missing email or refund from the outbox to the queue, reading queue state, replaying failed jobs

### Changed

- Refund jobs are queued by the outbox relay instead of directly by the API and the reconciler; the refund sweeper now only re-queues refunds still `PENDING` after a while

## [0.4.0] - 2026-10-15

M3: payments.

### Added

- `0005_payments.sql`: `payment_orders`, `payments`, `refunds` and `payment_webhook_events`
- Money rules in the database, each with a test: an order is for exactly its booking's total (a composite foreign key, which also freezes the total); at most one payment confirms a booking; a refund is for the full payment and happens at most once; every Razorpay id is recorded once
- `POST /api/v1/bookings/:id/payment-order`: creates the booking's Razorpay order once (201) and returns the same order afterwards (200); refuses a hold that has ended (409 `HOLD_NOT_ACTIVE`) or has under a minute left (409 `HOLD_ENDING_SOON`); 502 `PAYMENT_GATEWAY_ERROR` when Razorpay is down, with nothing stored
- Order creation survives crashes and races: the booking id is the Razorpay receipt, so a retry finds an order an earlier attempt created but never stored; the one-order-per-booking rule settles concurrent requests; no transaction is open while Razorpay is called
- `POST /api/v1/bookings/:id/payment/verify`: checks Checkout's signature (constant-time HMAC); it never confirms the booking, the webhook does
- `POST /webhooks/razorpay` (ADR 0007): signature checked on the raw body; each event stored once by `X-Razorpay-Event-Id`, in the same transaction that acts on it, so redeliveries change nothing
- Confirm transaction: with the booking locked, a captured payment confirms it only while the hold is active and every seat is still held by it; seats become `BOOKED` and the booking `CONFIRMED` in one commit
- Late, duplicate and wrong-amount payments are recorded and refunded in full (`HOLD_ENDED`, `DUPLICATE_PAYMENT`, `AMOUNT_MISMATCH`), never applied; one payment reported by both `payment.captured` and `order.paid` is applied once
- Refunds reach Razorpay: a BullMQ job per refund, queued after the transaction that records it and retried with backoff; our refund id is the Razorpay receipt, so a retry finds the first refund instead of making a second; a sweeper re-queues refunds still `PENDING`; `refund.processed` and `refund.failed` webhooks settle them, and a settled refund never changes again
- Reconciler in the worker: asks Razorpay about unconfirmed orders (1 minute to 24 hours old, each at most every 10 minutes, claimed with `SKIP LOCKED` so workers split them) and applies captured payments through the same confirm-or-refund code as the webhook
- `0006_payment_reconcile.sql`: `payment_orders.checked_at`
- Tests for forged, redelivered, reordered, concurrent and late webhooks, each followed by a money-and-seat invariant check
- `packages/payments` (`@bmt/payments`): a Razorpay client over `fetch`, an in-memory fake with the same interface for tests, and checkout and webhook signature checks
- `/dev/checkout` (development only) and [docs/runbooks/payments-local.md](docs/runbooks/payments-local.md) for paying in Razorpay test mode by hand
- Settings `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`; without keys the API runs and payment endpoints answer 503
- Worker settings `REFUND_SWEEP_INTERVAL_MS`, `RECONCILE_INTERVAL_MS`; the worker reads the Razorpay keys and runs refunds and the reconciler only when they are set

## [0.3.0] - 2026-10-15

M2: seat holds and concurrency.

### Added

- `0004_bookings.sql`: `bookings`, `booking_seats` and `idempotency_keys`; `show_seats.booking_id` records which booking holds or owns a seat
- Database rules, each with a test: a held seat has a booking and an expiry, a booked seat has a booking, a free seat has neither; one pending booking per user per show
- `POST /api/v1/bookings`: holds up to 5 seats for 5 minutes in one conditional `UPDATE`, all or nothing; 409 `SEATS_UNAVAILABLE` names the seats that were taken
- `Idempotency-Key` required on holds: a retry gets the first response back (`Idempotent-Replayed: true`); a key reused for a different request is refused; a failed request can be retried with its key
- One active hold per user per show (409 `ACTIVE_HOLD_EXISTS`); a hold that has run out never blocks its owner or other buyers
- `GET /api/v1/bookings/:id` (owner only) and `DELETE /api/v1/bookings/:id/hold`
- `HOLD_TTL_SECONDS` and `MAX_SEATS_PER_BOOKING` settings
- Concurrency tests: the naive read-then-write double booking reproduced; 200 buyers over 3 replicas get exactly one winner; overlapping multi-seat holds never split
- Three seat-hold strategies behind one interface, chosen with `HOLD_STRATEGY` (ADR 0005): `redis` (default: an all-or-nothing Redis lock in front of the conditional update), `conditional` (one statement) and `pessimistic` (`SELECT ... FOR UPDATE`, then update); the whole concurrency suite runs against each
- `redis` became the default after the benchmark: under contention it cut median hold latency from about 190 ms to 7 ms, and it costs nothing without contention
- The Redis strategy turns losers away before they touch Postgres, never decides ownership, and falls back to Postgres alone if Redis is down
- `make bench`: benchmarks the three strategies in a throwaway database, checks invariants after every run, and writes `docs/benchmarks/m2-hold-strategies.md`
- Hold expiry (ADR 0006): the API queues a BullMQ delayed job per hold (`hold-expiry`, job id = booking id); the worker expires the booking and frees its seats, leaving paid, cancelled and re-held seats alone
- A sweeper in every worker releases holds whose job was lost, at start-up and every 30 s, in `SKIP LOCKED` batches so several workers never release the same hold twice
- Queueing the expiry job never fails or slows a hold for more than 1 s when Redis is down; the sweeper catches it later
- `packages/jobs` (`@bmt/jobs`): queue names, payloads and SQL shared by the API (producer) and worker (consumer)
- Worker settings `HOLD_EXPIRY_CONCURRENCY`, `HOLD_SWEEP_INTERVAL_MS`, `HOLD_SWEEP_BATCH_SIZE`

## [0.2.0] - 2026-10-15

M1: accounts and catalog.

### Added

- Accounts with Better Auth (ADR 0004): email + password sign-up, sign-in and sign-out under `/api/auth`
- Sessions in Redis shared by every API replica, also written to Postgres
- `0002_identity.sql`: `users`, `sessions`, `accounts`, and a shared `set_updated_at()` trigger
- `GET /api/v1/me`; `requireAuth` and `requireRole` middleware; `user` and `admin` roles
- `make create-admin`: creates or promotes the admin from `ADMIN_*` in `.env`
- Integration test that fails if the migration drifts from Better Auth's expected schema
- `0003_catalog.sql`: cities, theatres, screens, seat categories, seats, movies, shows, show prices and per-show seat inventory
- Database rules for the catalog, each with a test: no overlapping shows on a screen, unique seats per screen, hold/expiry consistency, positive paise prices
- Data model section with an ER diagram in `docs/architecture.md`
- Admin API under `/api/v1/admin` (admin role only): cities, seat categories, theatres, screens with their seat layout, movies, shows
- Creating a show creates its prices and its whole seat inventory in one transaction; ends at start + duration + 15 min cleaning
- Overlapping shows are refused with 409 by the database's exclusion constraint, so two admins racing for one slot cannot both win
- Public browse API: cities, movies in a city on a date (in the city's time zone), a movie's shows by theatre with free-seat counts, show details, seat map
- Seat map reports only `AVAILABLE` / `UNAVAILABLE`; expired holds count as available
- `parseBody` / `parseQuery` / `parseParams` validation helpers and constraint-violation mapping to 409 / 400
- `formatPaise` in `packages/shared`
- `make seed`: demo data for Rourkela, 2 theatres, 3 screens, 3 movies, 4 shows a day for 7 days

## [0.1.0] - 2026-10-14

M0: foundations.

### Added

- npm workspaces monorepo: `apps/api`, `apps/worker`, `packages/platform`, `packages/shared`
- Docker Compose for Postgres 17, Redis 7 and Mailpit; `Makefile` targets
- Forward-only SQL migration runner with checksums and an advisory lock; `0001_extensions.sql`
- Express 5 API skeleton: validated config, pino request logging with request IDs, standard error body, `/healthz` and `/readyz`, graceful shutdown
- Worker process skeleton with graceful shutdown
- Vitest unit tests and Testcontainers integration tests
- GitHub Actions CI, PR and issue templates, Conventional Commits via commitlint and husky
- Docs: architecture overview, ADRs 0001 to 0003, local setup runbook

[Unreleased]: https://github.com/tilak-raaz/Tixora/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/tilak-raaz/Tixora/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/tilak-raaz/Tixora/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/tilak-raaz/Tixora/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/tilak-raaz/Tixora/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/tilak-raaz/Tixora/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/tilak-raaz/Tixora/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/tilak-raaz/Tixora/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/tilak-raaz/Tixora/releases/tag/v0.1.0
