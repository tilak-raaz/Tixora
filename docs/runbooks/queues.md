# Queues: what to check when something did not happen

Every side effect goes database → outbox → relay → queue → worker (ADR 0008). When an email or a
refund is missing, walk that chain from the left: the first place the thing stops is the cause.

All commands assume `make up` and a `.env` copied from `.env.example`.

## 1. Did the change commit, and was its event written?

```sql
-- make psql
SELECT id, topic, created_at, published_at, request_id
FROM outbox WHERE aggregate_id = '<booking or refund id>';
```

- **No row:** the change never committed (or it was not one that has an event). Nothing downstream
  will happen; that is correct.
- **`published_at` is empty:** the relay has not picked it up. Go to 2.
- **Published:** the job was queued. Go to 3. The `request_id` matches the API's log line for the
  request that caused it, and every job log line about it.

## 2. Is the relay running?

```sql
SELECT count(*), min(created_at) FROM outbox WHERE published_at IS NULL;
```

A count that grows, or an oldest row more than a few seconds old, means no worker is relaying.
Check that `make dev-worker` is running and its log has no `outbox relay failed` lines. The usual
cause is Redis being down: the relay rolls the batch back and retries every 500 ms, so the events
wait, nothing is lost, and they go out once Redis is back.

## 3. Where is the job?

```bash
make redis-cli
```

```text
LLEN  bmt:bull:email:wait        # waiting to run
LLEN  bmt:bull:email:active      # running now
ZCARD bmt:bull:email:delayed     # waiting for a retry's backoff
ZCARD bmt:bull:email:failed      # used up its attempts: the dead letter queue
```

Replace `email` with `refunds` or `hold-expiry` for the other queues. A job's id is its outbox id
(`HGETALL bmt:bull:email:<outbox id>` shows it, including `failedReason`).

- **Waiting and not moving:** no worker consumes that queue. Refunds need the Razorpay keys in the
  worker's `.env`.
- **Delayed:** it failed and is backing off (email: 5 attempts from 2 s; refunds: 8 from 5 s).
  The worker log says why.
- **Failed:** see 4.
- **Gone, and the effect did not happen:** jobs are kept for an hour (email: a day) after they
  complete; check `processed_messages` and the worker log for its outbox id.

A worker that dies mid-job (deploy, crash, `kill -9`) loses nothing: after its lock runs out
(30 s) another worker's stalled-job check puts the job back to waiting, and the log says
`email job stalled`. The failure drill test does exactly this.

## 4. Replaying the dead letter queue

```bash
make replay-dlq QUEUE=email DRY=1   # list failed jobs and why
make replay-dlq QUEUE=email         # after fixing the cause: move them back to waiting
```

Fix the cause first: a job replayed into the same problem just fails again. Replaying is always
safe, even for jobs that half-ran:

| Queue         | Why a repeat does no harm                                                      |
| ------------- | ------------------------------------------------------------------------------ |
| `email`       | `processed_messages` skips it; the outbox id is the provider's idempotency key |
| `refunds`     | the refund id is the Razorpay receipt, so Razorpay refuses a second refund     |
| `hold-expiry` | the release is a conditional update that does nothing for a hold already ended |

## 5. Money-specific checks

```sql
-- Refunds still not settled after an hour (the sweeper re-queues them every 5 minutes)
SELECT id, reason, status, razorpay_refund_id, created_at
FROM refunds WHERE status = 'PENDING' AND created_at < now() - interval '1 hour';

-- Refunds Razorpay gave up on: a person has to follow up in the Dashboard
SELECT id, reason, razorpay_refund_id, updated_at FROM refunds WHERE status = 'FAILED';

-- Bookings still waiting for payment long after their hold (the reconciler checks these)
SELECT b.id, b.expires_at, po.razorpay_order_id, po.checked_at
FROM bookings b JOIN payment_orders po ON po.booking_id = b.id
WHERE b.status = 'PENDING_PAYMENT' AND b.expires_at < now() - interval '10 minutes';
```
