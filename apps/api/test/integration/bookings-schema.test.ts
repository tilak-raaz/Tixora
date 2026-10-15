import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

/**
 * The booking rules in 0004_bookings.sql, each proven by trying to break it.
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
// Fixtures
// ---------------------------------------------------------------------------

const unique = () => randomUUID().slice(0, 8);

async function user(): Promise<string> {
  const row = await one<{ id: string }>(
    "INSERT INTO users (name, email) VALUES ('Test', $1) RETURNING id",
    [`u-${unique()}@example.com`],
  );
  return row.id;
}

/** A show with `seats` AVAILABLE inventory rows. */
async function showWithSeats(seats = 2): Promise<{ showId: string; showSeatIds: string[] }> {
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
  const category = await one<{ id: string }>(
    'INSERT INTO seat_categories (name) VALUES ($1) RETURNING id',
    [`Cat ${unique()}`],
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
  const showSeatIds: string[] = [];
  for (let n = 1; n <= seats; n++) {
    const seat = await one<{ id: string }>(
      `INSERT INTO seats (screen_id, category_id, row_label, seat_number, grid_x, grid_y)
       VALUES ($1, $2, 'A', $3, $3, 0) RETURNING id`,
      [screen.id, category.id, n],
    );
    const showSeat = await one<{ id: string }>(
      'INSERT INTO show_seats (show_id, seat_id, price_paise) VALUES ($1, $2, 20000) RETURNING id',
      [show.id, seat.id],
    );
    showSeatIds.push(showSeat.id);
  }
  return { showId: show.id, showSeatIds };
}

const INSERT_BOOKING = `INSERT INTO bookings (user_id, show_id, total_paise, expires_at)
                        VALUES ($1, $2, 40000, now() + interval '5 minutes') RETURNING id`;

async function booking(userId: string, showId: string): Promise<string> {
  return (await one<{ id: string }>(INSERT_BOOKING, [userId, showId])).id;
}

// ---------------------------------------------------------------------------

describe('bookings', () => {
  it('allows one pending booking per user per show', async () => {
    const u = await user();
    const { showId } = await showWithSeats();
    await booking(u, showId);

    await expectViolation(
      INSERT_BOOKING,
      [u, showId],
      UNIQUE,
      'bookings_one_pending_per_user_show',
    );
  });

  it('allows a new pending booking once the previous one has expired', async () => {
    const u = await user();
    const { showId } = await showWithSeats();
    const first = await booking(u, showId);
    await db.query("UPDATE bookings SET status = 'EXPIRED' WHERE id = $1", [first]);

    await booking(u, showId);
  });

  it('lets different users each hold a pending booking for the same show', async () => {
    const { showId } = await showWithSeats();
    await booking(await user(), showId);
    await booking(await user(), showId);
  });

  it('rejects an unknown status', async () => {
    const u = await user();
    const { showId } = await showWithSeats();
    const id = await booking(u, showId);
    await expectViolation(
      "UPDATE bookings SET status = 'PAID' WHERE id = $1",
      [id],
      CHECK,
      'bookings_status_valid',
    );
  });

  it('rejects a zero total', async () => {
    const u = await user();
    const { showId } = await showWithSeats();
    await expectViolation(
      `INSERT INTO bookings (user_id, show_id, total_paise, expires_at)
       VALUES ($1, $2, 0, now() + interval '5 minutes')`,
      [u, showId],
      CHECK,
      'bookings_total_positive',
    );
  });

  it('rejects an expiry that is not after creation', async () => {
    const u = await user();
    const { showId } = await showWithSeats();
    await expectViolation(
      'INSERT INTO bookings (user_id, show_id, total_paise, expires_at) VALUES ($1, $2, 100, now())',
      [u, showId],
      CHECK,
      'bookings_expires_after_created',
    );
  });

  it('requires confirmed_at on a CONFIRMED booking and cancelled_at on a CANCELLED one', async () => {
    const u = await user();
    const { showId } = await showWithSeats();
    const id = await booking(u, showId);
    await expectViolation(
      "UPDATE bookings SET status = 'CONFIRMED' WHERE id = $1",
      [id],
      CHECK,
      'bookings_confirmed_has_time',
    );
    await expectViolation(
      "UPDATE bookings SET status = 'CANCELLED' WHERE id = $1",
      [id],
      CHECK,
      'bookings_cancelled_has_time',
    );
    await db.query("UPDATE bookings SET status = 'CONFIRMED', confirmed_at = now() WHERE id = $1", [
      id,
    ]);
  });
});

describe('show_seats ownership', () => {
  const SET_SEAT = `UPDATE show_seats SET status = $2, booking_id = $3, held_until = $4 WHERE id = $1`;
  const IN_5_MIN = new Date(Date.now() + 5 * 60_000);

  async function seatAndBooking() {
    const u = await user();
    const { showId, showSeatIds } = await showWithSeats(1);
    return { seatId: showSeatIds[0]!, bookingId: await booking(u, showId) };
  }

  it('accepts a HELD seat with a booking and an expiry, then BOOKED with only the booking', async () => {
    const { seatId, bookingId } = await seatAndBooking();
    await db.query(SET_SEAT, [seatId, 'HELD', bookingId, IN_5_MIN]);
    await db.query(SET_SEAT, [seatId, 'BOOKED', bookingId, null]);
  });

  it.each([
    ['HELD without a booking', 'HELD', false, true],
    ['HELD without an expiry', 'HELD', true, false],
    ['BOOKED without a booking', 'BOOKED', false, false],
    ['BOOKED with an expiry', 'BOOKED', true, true],
    ['AVAILABLE with a booking', 'AVAILABLE', true, false],
    ['BLOCKED with a booking', 'BLOCKED', true, false],
  ])('rejects %s', async (_case, status, withBooking, withExpiry) => {
    const { seatId, bookingId } = await seatAndBooking();
    await expectViolation(
      SET_SEAT,
      [seatId, status, withBooking ? bookingId : null, withExpiry ? IN_5_MIN : null],
      CHECK,
      'show_seats_hold_consistency',
    );
  });

  it('refuses to delete a booking that still holds seats', async () => {
    const { seatId, bookingId } = await seatAndBooking();
    await db.query(SET_SEAT, [seatId, 'HELD', bookingId, IN_5_MIN]);
    await expectViolation('DELETE FROM bookings WHERE id = $1', [bookingId], FOREIGN_KEY);
  });
});

describe('booking_seats', () => {
  it('lists each seat once per booking', async () => {
    const u = await user();
    const { showId, showSeatIds } = await showWithSeats(1);
    const id = await booking(u, showId);
    const sql =
      'INSERT INTO booking_seats (booking_id, show_seat_id, price_paise) VALUES ($1, $2, 20000)';
    await db.query(sql, [id, showSeatIds[0]]);
    await expectViolation(sql, [id, showSeatIds[0]], UNIQUE);
  });

  it('rejects a zero price', async () => {
    const u = await user();
    const { showId, showSeatIds } = await showWithSeats(1);
    const id = await booking(u, showId);
    await expectViolation(
      'INSERT INTO booking_seats (booking_id, show_seat_id, price_paise) VALUES ($1, $2, 0)',
      [id, showSeatIds[0]],
      CHECK,
      'booking_seats_positive_price',
    );
  });
});

describe('idempotency_keys', () => {
  const INSERT_KEY = `INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1, $2, 'h')`;

  it('allows a key once per user, and the same key for another user', async () => {
    const a = await user();
    const b = await user();
    await db.query(INSERT_KEY, [a, 'key-1']);
    await db.query(INSERT_KEY, [b, 'key-1']);
    await expectViolation(INSERT_KEY, [a, 'key-1'], UNIQUE);
  });

  it('rejects an empty key', async () => {
    await expectViolation(INSERT_KEY, [await user(), ''], CHECK, 'idempotency_keys_key_length');
  });
});
