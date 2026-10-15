-- 0005: payments. A booking gets at most one Razorpay order. Every payment
-- Razorpay captures against that order is recorded; at most one of them
-- confirms the booking, and any other (a second payment of the same order, or
-- one that arrived after the hold ended) is refunded in full. Webhook events
-- are stored once, by Razorpay's event id.
--
-- The money rules are declarative, so no code path can break them:
--   * an order is for exactly its booking's total, and that total is then frozen
--   * at most one payment confirms a booking
--   * a refund is for exactly the payment's amount, and a payment is refunded at most once
--   * a Razorpay order, payment, refund or event id is recorded once
--   * INR only, in positive whole paise (ADR 0003)

-- Lets payment_orders reference (booking, total), so an order cannot carry a
-- different amount, and the total cannot change once an order exists.
ALTER TABLE bookings ADD CONSTRAINT bookings_id_total_key UNIQUE (id, total_paise);

CREATE TABLE payment_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        uuid NOT NULL,
  razorpay_order_id text NOT NULL,
  amount_paise      integer NOT NULL,
  currency          text NOT NULL DEFAULT 'INR',
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Asking twice for a booking's order returns the first one, never a second order.
  CONSTRAINT payment_orders_booking_key UNIQUE (booking_id),
  CONSTRAINT payment_orders_razorpay_order_key UNIQUE (razorpay_order_id),
  CONSTRAINT payment_orders_amount_matches_booking
    FOREIGN KEY (booking_id, amount_paise) REFERENCES bookings (id, total_paise) ON DELETE RESTRICT,
  CONSTRAINT payment_orders_currency_inr CHECK (currency = 'INR')
);

-- One row per payment Razorpay captured, whatever happened next. The amount is
-- what Razorpay actually took, so it is not tied to the order's: a mismatch
-- must still be recorded, so that it can be refunded.
CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            uuid NOT NULL REFERENCES payment_orders (id) ON DELETE RESTRICT,
  razorpay_payment_id text NOT NULL,
  amount_paise        integer NOT NULL,
  -- True for the one payment that confirmed the booking; every other payment is refunded.
  applied             boolean NOT NULL DEFAULT false,
  captured_at         timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_razorpay_payment_key UNIQUE (razorpay_payment_id),
  CONSTRAINT payments_amount_positive CHECK (amount_paise > 0),
  -- Lets refunds reference (payment, amount).
  CONSTRAINT payments_id_amount_key UNIQUE (id, amount_paise)
);

CREATE INDEX payments_order_idx ON payments (order_id);
-- Two captures racing to confirm the same booking: only one can be the applied one.
CREATE UNIQUE INDEX payments_one_applied_per_order ON payments (order_id) WHERE applied;

-- Full refunds only. PENDING until Razorpay has processed it (the refund job
-- retries); FAILED once retries run out and someone has to look.
CREATE TABLE refunds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id         uuid NOT NULL,
  amount_paise       integer NOT NULL,
  reason             text NOT NULL,
  status             text NOT NULL DEFAULT 'PENDING',
  razorpay_refund_id text,
  processed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- A retried refund request finds this row instead of refunding twice.
  CONSTRAINT refunds_payment_key UNIQUE (payment_id),
  CONSTRAINT refunds_full_amount
    FOREIGN KEY (payment_id, amount_paise) REFERENCES payments (id, amount_paise) ON DELETE RESTRICT,
  CONSTRAINT refunds_razorpay_refund_key UNIQUE (razorpay_refund_id),
  CONSTRAINT refunds_reason_valid
    CHECK (reason IN ('HOLD_ENDED', 'DUPLICATE_PAYMENT', 'AMOUNT_MISMATCH')),
  CONSTRAINT refunds_status_valid CHECK (status IN ('PENDING', 'PROCESSED', 'FAILED')),
  CONSTRAINT refunds_processed_has_details
    CHECK (status <> 'PROCESSED' OR (razorpay_refund_id IS NOT NULL AND processed_at IS NOT NULL))
);

-- The refund job and the reconciler look only at refunds still in flight.
CREATE INDEX refunds_pending_idx ON refunds (created_at) WHERE status = 'PENDING';

CREATE TRIGGER refunds_set_updated_at BEFORE UPDATE ON refunds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Every webhook Razorpay sends, stored once by its event id (the
-- X-Razorpay-Event-Id header). Storing it and acting on it happen in one
-- transaction, so a redelivered event finds its row and changes nothing.
CREATE TABLE payment_webhook_events (
  event_id    text PRIMARY KEY,
  event_type  text NOT NULL,
  payload     jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
