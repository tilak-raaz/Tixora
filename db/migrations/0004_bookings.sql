-- 0004: bookings, the seats in each booking, and idempotency keys; show_seats
-- learns which booking owns it.
--
-- A booking starts PENDING_PAYMENT while its seats are HELD (5 minutes, set by
-- the API), then becomes CONFIRMED (payment, M3), EXPIRED (hold ran out) or
-- CANCELLED. Seat ownership still lives only in show_seats.booking_id.

CREATE TABLE bookings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  show_id      uuid NOT NULL REFERENCES shows (id) ON DELETE RESTRICT,
  status       text NOT NULL DEFAULT 'PENDING_PAYMENT',
  -- What the user pays: the sum of booking_seats.price_paise, fixed at hold time.
  total_paise  integer NOT NULL,
  -- When the hold on this booking's seats runs out.
  expires_at   timestamptz NOT NULL,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bookings_status_valid
    CHECK (status IN ('PENDING_PAYMENT', 'CONFIRMED', 'EXPIRED', 'CANCELLED')),
  CONSTRAINT bookings_total_positive CHECK (total_paise > 0),
  CONSTRAINT bookings_expires_after_created CHECK (expires_at > created_at),
  CONSTRAINT bookings_confirmed_has_time CHECK (status <> 'CONFIRMED' OR confirmed_at IS NOT NULL),
  CONSTRAINT bookings_cancelled_has_time CHECK (status <> 'CANCELLED' OR cancelled_at IS NOT NULL)
);

-- A user has at most one pending booking per show. Two quick taps on "Book"
-- race to this index, and only one wins.
CREATE UNIQUE INDEX bookings_one_pending_per_user_show
  ON bookings (user_id, show_id) WHERE status = 'PENDING_PAYMENT';

-- "My bookings", newest first.
CREATE INDEX bookings_user_created_idx ON bookings (user_id, created_at DESC);
-- The expiry sweeper scans only pending bookings, oldest expiry first.
CREATE INDEX bookings_pending_expiry_idx ON bookings (expires_at) WHERE status = 'PENDING_PAYMENT';

CREATE TRIGGER bookings_set_updated_at BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The seats a booking covers, with the price each was held at. Kept after the
-- booking ends, as the record of what was bought.
CREATE TABLE booking_seats (
  booking_id   uuid NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  show_seat_id uuid NOT NULL REFERENCES show_seats (id) ON DELETE RESTRICT,
  price_paise  integer NOT NULL,
  PRIMARY KEY (booking_id, show_seat_id),
  CONSTRAINT booking_seats_positive_price CHECK (price_paise > 0)
);

CREATE INDEX booking_seats_show_seat_idx ON booking_seats (show_seat_id);

-- show_seats: who holds or owns the seat.
ALTER TABLE show_seats
  ADD COLUMN booking_id uuid REFERENCES bookings (id) ON DELETE RESTRICT;

-- Replaces the M1 rule (HELD <=> held_until) under the same name, now covering
-- the owner too:
--   AVAILABLE, BLOCKED: no booking, no expiry
--   HELD:               a booking and an expiry
--   BOOKED:             a booking, no expiry
ALTER TABLE show_seats DROP CONSTRAINT show_seats_hold_consistency;
ALTER TABLE show_seats ADD CONSTRAINT show_seats_hold_consistency CHECK (
     (status IN ('AVAILABLE', 'BLOCKED') AND booking_id IS NULL     AND held_until IS NULL)
  OR (status = 'HELD'                    AND booking_id IS NOT NULL AND held_until IS NOT NULL)
  OR (status = 'BOOKED'                  AND booking_id IS NOT NULL AND held_until IS NULL)
);

CREATE INDEX show_seats_booking_idx ON show_seats (booking_id) WHERE booking_id IS NOT NULL;

-- Idempotency keys: a retried POST with the same key gets the first response
-- back instead of doing the work twice. response_status is NULL while the first
-- request is still running.
CREATE TABLE idempotency_keys (
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key             text NOT NULL,
  -- Hash of the request body: reusing a key for a different request is an error.
  request_hash    text NOT NULL,
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key),
  CONSTRAINT idempotency_keys_key_length CHECK (char_length(key) BETWEEN 1 AND 255)
);

-- Old keys are deleted by age.
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);
