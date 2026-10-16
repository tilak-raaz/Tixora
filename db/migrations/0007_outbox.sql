-- 0007: the transactional outbox, and the record of what each consumer has done.
--
-- A state change that must cause a side effect (an email, a refund sent to
-- Razorpay) inserts an outbox row in the same transaction. The relay in the
-- worker queues a job for each row and marks it published, so a side effect
-- happens if and only if its change committed (ADR 0008).

CREATE TABLE outbox (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic        text NOT NULL,
  -- The row the event is about (a booking, a refund), for finding its events.
  aggregate_id uuid NOT NULL,
  payload      jsonb NOT NULL,
  -- The HTTP request that caused it, so job logs join up with request logs.
  request_id   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT outbox_topic_valid CHECK (topic IN ('booking.confirmed', 'refund.recorded'))
);

-- The relay reads only unpublished rows, oldest first.
CREATE INDEX outbox_unpublished_idx ON outbox (created_at) WHERE published_at IS NULL;
CREATE INDEX outbox_aggregate_idx ON outbox (aggregate_id);

-- Delivery is at least once, so a consumer records each message it has
-- finished; seeing one again, it skips it. Keyed per consumer, because one
-- event can feed several (a refund is both sent and emailed about).
CREATE TABLE processed_messages (
  consumer     text NOT NULL,
  message_id   uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, message_id)
);
