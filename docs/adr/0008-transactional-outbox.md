# 0008. Side effects go through a transactional outbox

- Status: Accepted
- Date: 2026-10-16

## Context

Some state changes must cause something outside Postgres: a confirmed booking needs its
confirmation email, and a recorded refund needs to reach Razorpay and the buyer needs to hear
about it. Doing that directly from the code that commits the change fails in both directions:

- **Queue after commit:** the process can die between the commit and the queue call. The booking
  is confirmed and nobody is ever told. M3 covered refunds this way with a sweeper, but that is a
  second mechanism per side effect.
- **Queue before or inside the transaction:** the job can run, or the email go out, for a change
  that then rolls back.

A distributed transaction across Postgres and Redis is not on offer.

## Decision

- **The change and its event commit together.** The transaction that confirms a booking inserts a
  `booking.confirmed` row into `outbox`; the one that records a refund inserts `refund.recorded`.
  An event exists if and only if its change committed. The HTTP request id is stored with it.
- **A relay in the worker publishes events.** In one short transaction it locks a batch of
  unpublished rows with `FOR UPDATE SKIP LOCKED`, queues a BullMQ job per row and route with the
  outbox id as the job id, and marks the rows published. Relays in several workers split the rows
  between them. The relay polls every 500 ms.
- **Routing is a table, not code at each call site:** `booking.confirmed` goes to the email queue;
  `refund.recorded` goes to the refund queue (sent to Razorpay) and the email queue. The API and
  the reconciler no longer queue refund jobs themselves.
- **Delivery is at least once; handling is once.** A relay that dies after queuing but before its
  commit leaves the rows unpublished, and the next relay queues them again under the same job ids,
  which BullMQ ignores while the first jobs exist. Consumers still deduplicate on the outbox id:
  refunds through the Razorpay receipt (ADR 0007), emails through `processed_messages` and the
  email provider's idempotency key (M4 PR 2).
- **Hold expiry stays a directly queued delayed job** (ADR 0006). A lost one costs nothing but a
  late cleanup, and its sweeper already covers it.

## Consequences

- Every side effect starts the same way, so there is one place to look when one goes missing:
  an unpublished outbox row, or a job in the failed set.
- The relay calls Redis while holding row locks on outbox rows (never on bookings or payments).
  The call has a 2-second timeout, so a Redis outage rolls the batch back and the events wait.
- Emails can lag a commit by up to the poll interval. `LISTEN/NOTIFY` could wake the relay sooner
  if that ever matters.
- Published rows accumulate; deleting old ones is a later housekeeping job.
- In the Kafka extension, the relay would publish to Kafka instead and nothing else would change.
