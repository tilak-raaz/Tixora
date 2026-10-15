-- 0006: lets the reconciler ask Razorpay about each order now and then, not on every pass.
-- checked_at is when an order was last claimed for a check; a claim and its
-- check are separate steps, so no row lock is held while Razorpay answers.

ALTER TABLE payment_orders ADD COLUMN checked_at timestamptz;

-- Orders the reconciler may look at: recent ones, least recently checked first.
CREATE INDEX payment_orders_created_idx ON payment_orders (created_at);
