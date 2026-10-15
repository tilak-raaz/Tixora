import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

/**
 * The money rules in 0005_payments.sql, each proven by trying to break it.
 * Every test runs in a transaction that is rolled back afterwards.
 */

let pool: Pool;
let db: PoolClient;

beforeAll(() => {
  pool = new pg.Pool({ connectionString: inject('databaseUrl'), max: 2 });
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  db = await pool.connect();
  await db.query('BEGIN');
});
afterEach(async () => {
  await db.query('ROLLBACK');
  db.release();
});

const UNIQUE = '23505';
const CHECK = '23514';
const FOREIGN_KEY = '23503';

async function expectViolation(
  sql: string,
  params: unknown[],
  code: string,
  constraint?: string,
): Promise<void> {
  await db.query('SAVEPOINT expect_violation');
  try {
    await db.query(sql, params);
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT expect_violation');
    expect(err).toMatchObject(constraint ? { code, constraint } : { code });
    return;
  }
  throw new Error(
    `Expected error ${code}${constraint ? ` (${constraint})` : ''}, but it succeeded`,
  );
}

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query(sql, params);
  return rows[0] as T;
}

// ---------------------------------------------------------------------------
// Fixtures: just enough catalog for a booking of ₹400.
// ---------------------------------------------------------------------------

const unique = () => randomUUID().slice(0, 8);
const TOTAL = 40_000;

async function booking(): Promise<string> {
  const user = await one<{ id: string }>(
    "INSERT INTO users (name, email) VALUES ('Test', $1) RETURNING id",
    [`u-${unique()}@example.com`],
  );
  const city = await one<{ id: string }>(
    "INSERT INTO cities (name, slug, state) VALUES ('C', $1, 'S') RETURNING id",
    [`c-${unique()}`],
  );
  const theatre = await one<{ id: string }>(
    "INSERT INTO theatres (city_id, name, address) VALUES ($1, 'T', 'A') RETURNING id",
    [city.id],
  );
  const screen = await one<{ id: string }>(
    "INSERT INTO screens (theatre_id, name) VALUES ($1, 'S1') RETURNING id",
    [theatre.id],
  );
  const movie = await one<{ id: string }>(
    `INSERT INTO movies (title, language, duration_min, release_date)
     VALUES ($1, 'Hindi', 120, '2026-06-01') RETURNING id`,
    [`M ${unique()}`],
  );
  const show = await one<{ id: string }>(
    `INSERT INTO shows (movie_id, screen_id, starts_at, ends_at)
     VALUES ($1, $2, now() + interval '1 day', now() + interval '1 day 3 hours') RETURNING id`,
    [movie.id, screen.id],
  );
  const row = await one<{ id: string }>(
    `INSERT INTO bookings (user_id, show_id, total_paise, expires_at)
     VALUES ($1, $2, $3, now() + interval '5 minutes') RETURNING id`,
    [user.id, show.id, TOTAL],
  );
  return row.id;
}

const INSERT_ORDER =
  'INSERT INTO payment_orders (booking_id, razorpay_order_id, amount_paise) VALUES ($1, $2, $3) RETURNING id';

async function order(bookingId?: string): Promise<string> {
  const row = await one<{ id: string }>(INSERT_ORDER, [
    bookingId ?? (await booking()),
    `order_${unique()}`,
    TOTAL,
  ]);
  return row.id;
}

const INSERT_PAYMENT = `INSERT INTO payments (order_id, razorpay_payment_id, amount_paise, applied, captured_at)
                        VALUES ($1, $2, $3, $4, now()) RETURNING id`;

async function payment(orderId: string, applied = false): Promise<string> {
  const row = await one<{ id: string }>(INSERT_PAYMENT, [
    orderId,
    `pay_${unique()}`,
    TOTAL,
    applied,
  ]);
  return row.id;
}

const INSERT_REFUND =
  'INSERT INTO refunds (payment_id, amount_paise, reason) VALUES ($1, $2, $3) RETURNING id';

// ---------------------------------------------------------------------------

describe('payment_orders', () => {
  it('gives a booking at most one order', async () => {
    const b = await booking();
    await order(b);
    await expectViolation(
      INSERT_ORDER,
      [b, `order_${unique()}`, TOTAL],
      UNIQUE,
      'payment_orders_booking_key',
    );
  });

  it('records a Razorpay order id once', async () => {
    const id = `order_${unique()}`;
    await db.query(INSERT_ORDER, [await booking(), id, TOTAL]);
    await expectViolation(
      INSERT_ORDER,
      [await booking(), id, TOTAL],
      UNIQUE,
      'payment_orders_razorpay_order_key',
    );
  });

  it('refuses an order for a different amount than the booking total', async () => {
    await expectViolation(
      INSERT_ORDER,
      [await booking(), `order_${unique()}`, TOTAL - 100],
      FOREIGN_KEY,
      'payment_orders_amount_matches_booking',
    );
  });

  it('freezes the booking total once an order exists', async () => {
    const b = await booking();
    await order(b);
    await expectViolation(
      'UPDATE bookings SET total_paise = total_paise + 100 WHERE id = $1',
      [b],
      FOREIGN_KEY,
      'payment_orders_amount_matches_booking',
    );
  });

  it('accepts INR only', async () => {
    await expectViolation(
      `INSERT INTO payment_orders (booking_id, razorpay_order_id, amount_paise, currency)
       VALUES ($1, $2, $3, 'USD')`,
      [await booking(), `order_${unique()}`, TOTAL],
      CHECK,
      'payment_orders_currency_inr',
    );
  });
});

describe('payments', () => {
  it('records a Razorpay payment id once', async () => {
    const o = await order();
    const id = `pay_${unique()}`;
    await db.query(INSERT_PAYMENT, [o, id, TOTAL, false]);
    await expectViolation(
      INSERT_PAYMENT,
      [o, id, TOTAL, false],
      UNIQUE,
      'payments_razorpay_payment_key',
    );
  });

  it('lets only one payment of an order confirm the booking, and keeps the others for refund', async () => {
    const o = await order();
    await payment(o, true);
    await payment(o, false); // a second capture is still recorded, so it can be refunded

    await expectViolation(
      INSERT_PAYMENT,
      [o, `pay_${unique()}`, TOTAL, true],
      UNIQUE,
      'payments_one_applied_per_order',
    );
  });

  it('rejects a zero amount', async () => {
    await expectViolation(
      INSERT_PAYMENT,
      [await order(), `pay_${unique()}`, 0, false],
      CHECK,
      'payments_amount_positive',
    );
  });
});

describe('refunds', () => {
  it('refunds the full payment, never more or less', async () => {
    const p = await payment(await order());
    for (const amount of [TOTAL - 1, TOTAL + 1]) {
      await expectViolation(
        INSERT_REFUND,
        [p, amount, 'HOLD_ENDED'],
        FOREIGN_KEY,
        'refunds_full_amount',
      );
    }
    await db.query(INSERT_REFUND, [p, TOTAL, 'HOLD_ENDED']);
  });

  it('refunds a payment at most once', async () => {
    const p = await payment(await order());
    await db.query(INSERT_REFUND, [p, TOTAL, 'DUPLICATE_PAYMENT']);
    await expectViolation(
      INSERT_REFUND,
      [p, TOTAL, 'DUPLICATE_PAYMENT'],
      UNIQUE,
      'refunds_payment_key',
    );
  });

  it('requires the Razorpay refund id and time on a PROCESSED refund', async () => {
    const p = await payment(await order());
    const refund = await one<{ id: string }>(INSERT_REFUND, [p, TOTAL, 'HOLD_ENDED']);
    await expectViolation(
      "UPDATE refunds SET status = 'PROCESSED' WHERE id = $1",
      [refund.id],
      CHECK,
      'refunds_processed_has_details',
    );
    await db.query(
      "UPDATE refunds SET status = 'PROCESSED', razorpay_refund_id = $2, processed_at = now() WHERE id = $1",
      [refund.id, `rfnd_${unique()}`],
    );
  });

  it('rejects an unknown reason or status', async () => {
    const p = await payment(await order());
    await expectViolation(INSERT_REFUND, [p, TOTAL, 'CHANGED_MIND'], CHECK, 'refunds_reason_valid');
    const refund = await one<{ id: string }>(INSERT_REFUND, [p, TOTAL, 'HOLD_ENDED']);
    await expectViolation(
      "UPDATE refunds SET status = 'DONE' WHERE id = $1",
      [refund.id],
      CHECK,
      'refunds_status_valid',
    );
  });
});

describe('payment_webhook_events', () => {
  it('stores each Razorpay event once', async () => {
    const sql =
      "INSERT INTO payment_webhook_events (event_id, event_type, payload) VALUES ($1, 'payment.captured', '{}')";
    const id = `evt_${unique()}`;
    await db.query(sql, [id]);
    await expectViolation(sql, [id], UNIQUE, 'payment_webhook_events_pkey');
  });
});
