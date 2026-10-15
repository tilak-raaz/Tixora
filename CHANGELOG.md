# Changelog

All notable changes are recorded here, one section per release tag.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions: [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/tilak-raaz/Tixora/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/tilak-raaz/Tixora/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/tilak-raaz/Tixora/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/tilak-raaz/Tixora/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/tilak-raaz/Tixora/releases/tag/v0.1.0
