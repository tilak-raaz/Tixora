# Changelog

All notable changes are recorded here, one section per release tag.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions: [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `apps/web`: Next.js (App Router) frontend with Tailwind CSS theme tokens (red primary, ink, surface), Manrope and Inter, and small components: button, tag, sheet, toast, skeleton (ADR 0012)
- One origin for the browser: `/api/*` is forwarded to the API, so the session cookie is first-party and there is no CORS
- Typed `api()` client that turns every error response into an `ApiError` carrying the API's error code and `Retry-After`; Better Auth's React client for sessions
- `make dev-web` and `make build-web`; CI and `make check` now build the web app
- Browse pages: now showing in a city by date (city remembered in a cookie), a movie with its shows grouped by theatre, and a show's details and prices; times are shown in the city's time zone
- Sign-in and sign-up pages with Better Auth, returning to the page you came from (same-site paths only)
- Ticket-stub design: movie cards, dates and show times are tickets with a perforated tear line and notched stubs; Anton for headlines and poster titles, Schibsted Grotesk for text; the city picker lives in the header
- Typographic posters (flat palette colour, frame, rating box, title in poster type) for movies without an image; loading, empty, error and 404 states
- Server-rendered pages pass the visitor's address to the API in `X-Forwarded-For` (last proxy entry only), so per-IP browse limits stay per visitor
- Seat map on the show page: screen at the top, a price heading per seat category, aisles as gaps; pick up to 5 seats, hold them, and go to your seats with a 5:00 countdown (red in the last minute) and a way to release them
- The show page and the checkout open on a ticket in the movie's poster colour, so the look of the poster carries through to the countdown
- The map stays live: it follows seat events, reloads on reconnect, `resync` or a gap the heartbeat exposes, and a seat someone else takes flashes once; a picked seat taken by someone else is dropped with a message
- Holding handles every answer: seats just taken (dropped, map reloaded), a hold already open for the show, rate limiting, and signing in first (the picked seats wait in the tab and come back)
- Paying in the web app: Razorpay Checkout, then a signature check and "Confirming your booking" until the webhook confirms it (up to 30 s), then the ticket; a payment that arrives after the hold ended explains the automatic refund
- Fake payment mode (`PAYMENT_GATEWAY=fake`, never in production): a test sheet with Pay and Fail; it answers like Checkout and sends a signed webhook through the real handler a moment later, so bookings are still confirmed only by the webhook
- Ticket page (`/bookings/:id`) with the booking reference and the PDF to download, and My bookings (`/bookings`): waiting for payment, coming up, watched and not booked
- `GET /api/v1/bookings`: the signed-in user's bookings, newest first, with their show and seats
- Playwright end-to-end tests in CI (`make e2e`), on ports of their own with fake payments: sign up, pick seats, pay and get the ticket; a hold in one browser turning the seat taken in another, and its release freeing it, without a reload; a failed payment keeping the hold; a hold that runs out
- README screenshots
- Live seat updates (ADR 0013): `GET /api/v1/shows/:id/seats/events` streams seat changes as Server-Sent Events (`ready`, `seats`, `heartbeat`, `resync`)
- Every seat change publishes the seats' state after it commits, on the show's Redis channel: holds, releases, expiry by job, sweeper or a new hold, and payments confirmed by the webhook or the reconciler
- One Redis subscription per show per replica, dropped when its last viewer leaves; a reconnected subscription tells its viewers to resync
- The heartbeat carries the show's seat version, so a browser notices an event it never received; the seat map now includes each seat's `version`
- Limits: opening a stream counts against the browse limit, and a replica keeps at most 6 streams open per IP
- Tests: a hold on one replica seen on the other within a second, a release with a higher version, the worker's expiry reaching viewers on both replicas, a lost event exposed by the heartbeat, subscribe-once and unsubscribe, resync after the subscriber connection is killed, the stream limit, and the publisher surviving an unreachable Redis

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

[Unreleased]: https://github.com/tilak-raaz/Tixora/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/tilak-raaz/Tixora/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/tilak-raaz/Tixora/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/tilak-raaz/Tixora/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/tilak-raaz/Tixora/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/tilak-raaz/Tixora/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/tilak-raaz/Tixora/releases/tag/v0.1.0
