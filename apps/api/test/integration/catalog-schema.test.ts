import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

/**
 * The catalog's rules live in the database (0003_catalog.sql). These tests prove
 * each one by trying to break it. Every test runs inside a transaction that is
 * rolled back afterwards, so tests leave no rows behind.
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

/** Postgres error codes we assert on. */
const UNIQUE = '23505';
const CHECK = '23514';
const FOREIGN_KEY = '23503';
const EXCLUSION = '23P01';

/**
 * Runs a statement that must fail with the given code (and constraint, when given).
 * A savepoint keeps the surrounding test transaction usable afterwards.
 */
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
// Fixtures: minimal valid rows. Random names keep them unique.
// ---------------------------------------------------------------------------

const unique = () => randomUUID().slice(0, 8);

async function city() {
  const slug = `city-${unique()}`;
  return one<{ id: string }>(
    "INSERT INTO cities (name, slug, state) VALUES ($1, $1, 'Odisha') RETURNING id",
    [slug],
  );
}

async function theatre(cityId?: string) {
  const c = cityId ?? (await city()).id;
  return one<{ id: string; city_id: string }>(
    "INSERT INTO theatres (city_id, name, address) VALUES ($1, $2, 'Main Road') RETURNING id, city_id",
    [c, `Theatre ${unique()}`],
  );
}

async function screen() {
  const t = await theatre();
  return one<{ id: string }>(
    "INSERT INTO screens (theatre_id, name) VALUES ($1, 'Screen 1') RETURNING id",
    [t.id],
  );
}

async function category() {
  return one<{ id: string }>('INSERT INTO seat_categories (name) VALUES ($1) RETURNING id', [
    `Tier ${unique()}`,
  ]);
}

async function seat(screenId: string, row = 'A', number = 1, x = 0, y = 0) {
  const c = await category();
  return one<{ id: string }>(
    `INSERT INTO seats (screen_id, category_id, row_label, seat_number, grid_x, grid_y)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [screenId, c.id, row, number, x, y],
  );
}

async function movie() {
  return one<{ id: string }>(
    `INSERT INTO movies (title, language, duration_min, certificate, release_date)
     VALUES ($1, 'Hindi', 145, 'UA13+', '2026-06-01') RETURNING id`,
    [`Movie ${unique()}`],
  );
}

async function show(screenId: string, startsAt: string, endsAt: string, status = 'SCHEDULED') {
  const m = await movie();
  return one<{ id: string }>(
    `INSERT INTO shows (movie_id, screen_id, starts_at, ends_at, status)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [m.id, screenId, startsAt, endsAt, status],
  );
}

const INSERT_SHOW = `INSERT INTO shows (movie_id, screen_id, starts_at, ends_at, status)
                     VALUES ($1, $2, $3, $4, $5)`;

// ---------------------------------------------------------------------------

describe('cities', () => {
  it('rejects a slug that is not lowercase-with-hyphens', async () => {
    await expectViolation(
      "INSERT INTO cities (name, slug, state) VALUES ('Rourkela', 'Rour Kela', 'Odisha')",
      [],
      CHECK,
      'cities_slug_format',
    );
  });

  it('rejects a duplicate slug', async () => {
    await db.query(
      "INSERT INTO cities (name, slug, state) VALUES ('Rourkela', 'rourkela-t', 'Odisha')",
    );
    await expectViolation(
      "INSERT INTO cities (name, slug, state) VALUES ('Rourkela 2', 'rourkela-t', 'Odisha')",
      [],
      UNIQUE,
      'cities_slug_key',
    );
  });

  it('defaults the timezone to Asia/Kolkata', async () => {
    const c = await city();
    const row = await one<{ timezone: string }>('SELECT timezone FROM cities WHERE id = $1', [
      c.id,
    ]);
    expect(row.timezone).toBe('Asia/Kolkata');
  });
});

describe('theatres and screens', () => {
  it('allows one theatre name per city, but the same name in another city', async () => {
    const a = await city();
    const b = await city();
    const sql = "INSERT INTO theatres (city_id, name, address) VALUES ($1, 'PVR Mall', 'x')";
    await db.query(sql, [a.id]);
    await db.query(sql, [b.id]);
    await expectViolation(sql, [a.id], UNIQUE, 'theatres_city_name_key');
  });

  it('allows one screen name per theatre', async () => {
    const t = await theatre();
    const sql = "INSERT INTO screens (theatre_id, name) VALUES ($1, 'Audi 1')";
    await db.query(sql, [t.id]);
    await expectViolation(sql, [t.id], UNIQUE, 'screens_theatre_name_key');
  });

  it('refuses to delete a city that still has theatres', async () => {
    const t = await theatre();
    await expectViolation('DELETE FROM cities WHERE id = $1', [t.city_id], FOREIGN_KEY);
  });
});

describe('seats', () => {
  it('rejects two seats with the same row and number on one screen', async () => {
    const s = await screen();
    await seat(s.id, 'A', 1, 0, 0);
    const c = await category();
    await expectViolation(
      `INSERT INTO seats (screen_id, category_id, row_label, seat_number, grid_x, grid_y)
       VALUES ($1, $2, 'A', 1, 5, 5)`,
      [s.id, c.id],
      UNIQUE,
      'seats_screen_row_number_key',
    );
  });

  it('rejects two seats in the same grid position', async () => {
    const s = await screen();
    await seat(s.id, 'A', 1, 3, 4);
    const c = await category();
    await expectViolation(
      `INSERT INTO seats (screen_id, category_id, row_label, seat_number, grid_x, grid_y)
       VALUES ($1, $2, 'B', 7, 3, 4)`,
      [s.id, c.id],
      UNIQUE,
      'seats_screen_grid_key',
    );
  });

  it.each([
    ['lowercase row', 'a', 1],
    ['three-letter row', 'ABC', 1],
    ['seat number 0', 'A', 0],
  ])('rejects %s', async (_case, row, number) => {
    const s = await screen();
    const c = await category();
    await expectViolation(
      `INSERT INTO seats (screen_id, category_id, row_label, seat_number, grid_x, grid_y)
       VALUES ($1, $2, $3, $4, 0, 0)`,
      [s.id, c.id, row, number],
      CHECK,
    );
  });

  it("deletes a screen's seats with the screen", async () => {
    const s = await screen();
    await seat(s.id);
    await db.query('DELETE FROM screens WHERE id = $1', [s.id]);
    const { rowCount } = await db.query('SELECT 1 FROM seats WHERE screen_id = $1', [s.id]);
    expect(rowCount).toBe(0);
  });
});

describe('movies', () => {
  const INSERT_MOVIE = `INSERT INTO movies (title, language, duration_min, certificate, release_date)
                        VALUES ($1, $2, $3, $4, '2026-06-01')`;

  it('allows the same title in another language', async () => {
    const title = `Film ${unique()}`;
    await db.query(INSERT_MOVIE, [title, 'Hindi', 120, 'U']);
    await db.query(INSERT_MOVIE, [title, 'Odia', 120, 'U']);
    await expectViolation(
      INSERT_MOVIE,
      [title, 'Hindi', 120, 'U'],
      UNIQUE,
      'movies_title_language_release_key',
    );
  });

  it('rejects a zero-minute movie', async () => {
    await expectViolation(
      INSERT_MOVIE,
      [`Film ${unique()}`, 'Hindi', 0, 'U'],
      CHECK,
      'movies_duration_range',
    );
  });
});

describe('shows', () => {
  it('rejects a show that ends before it starts', async () => {
    const s = await screen();
    const m = await movie();
    await expectViolation(
      INSERT_SHOW,
      [m.id, s.id, '2026-06-14T12:00:00Z', '2026-06-14T10:00:00Z', 'SCHEDULED'],
      CHECK,
      'shows_ends_after_start',
    );
  });

  it('rejects two scheduled shows overlapping on one screen', async () => {
    const s = await screen();
    await show(s.id, '2026-06-14T10:00:00Z', '2026-06-14T13:00:00Z');
    const m = await movie();
    await expectViolation(
      INSERT_SHOW,
      [m.id, s.id, '2026-06-14T12:30:00Z', '2026-06-14T15:00:00Z', 'SCHEDULED'],
      EXCLUSION,
      'shows_no_overlap',
    );
  });

  it('allows a show to start exactly when the previous one ends', async () => {
    const s = await screen();
    await show(s.id, '2026-06-14T10:00:00Z', '2026-06-14T13:00:00Z');
    await show(s.id, '2026-06-14T13:00:00Z', '2026-06-14T16:00:00Z');
  });

  it('allows the same time slot on a different screen', async () => {
    const a = await screen();
    const b = await screen();
    await show(a.id, '2026-06-14T10:00:00Z', '2026-06-14T13:00:00Z');
    await show(b.id, '2026-06-14T10:00:00Z', '2026-06-14T13:00:00Z');
  });

  it('frees the slot when a show is cancelled', async () => {
    const s = await screen();
    const first = await show(s.id, '2026-06-14T10:00:00Z', '2026-06-14T13:00:00Z');
    await db.query("UPDATE shows SET status = 'CANCELLED' WHERE id = $1", [first.id]);
    await show(s.id, '2026-06-14T11:00:00Z', '2026-06-14T14:00:00Z');
  });

  it('refuses to delete a movie that has shows', async () => {
    const s = await screen();
    const sh = await show(s.id, '2026-06-14T10:00:00Z', '2026-06-14T13:00:00Z');
    const { movie_id } = await one<{ movie_id: string }>(
      'SELECT movie_id FROM shows WHERE id = $1',
      [sh.id],
    );
    await expectViolation('DELETE FROM movies WHERE id = $1', [movie_id], FOREIGN_KEY);
  });
});

describe('show prices and show seats', () => {
  async function showWithSeat() {
    const s = await screen();
    const st = await seat(s.id);
    const sh = await show(s.id, '2026-06-14T10:00:00Z', '2026-06-14T13:00:00Z');
    return { showId: sh.id, seatId: st.id };
  }

  it('rejects a zero price', async () => {
    const { showId } = await showWithSeat();
    const c = await category();
    await expectViolation(
      'INSERT INTO show_prices (show_id, category_id, price_paise) VALUES ($1, $2, 0)',
      [showId, c.id],
      CHECK,
      'show_prices_positive',
    );
  });

  it('allows one inventory row per seat per show', async () => {
    const { showId, seatId } = await showWithSeat();
    const sql = 'INSERT INTO show_seats (show_id, seat_id, price_paise) VALUES ($1, $2, 22000)';
    await db.query(sql, [showId, seatId]);
    await expectViolation(sql, [showId, seatId], UNIQUE, 'show_seats_show_seat_key');
  });

  it('starts every seat AVAILABLE at version 0', async () => {
    const { showId, seatId } = await showWithSeat();
    const row = await one<{ status: string; version: number; held_until: Date | null }>(
      `INSERT INTO show_seats (show_id, seat_id, price_paise) VALUES ($1, $2, 22000)
       RETURNING status, version, held_until`,
      [showId, seatId],
    );
    expect(row).toEqual({ status: 'AVAILABLE', version: 0, held_until: null });
  });

  it('rejects a HELD seat without an expiry', async () => {
    const { showId, seatId } = await showWithSeat();
    await expectViolation(
      "INSERT INTO show_seats (show_id, seat_id, price_paise, status) VALUES ($1, $2, 22000, 'HELD')",
      [showId, seatId],
      CHECK,
      'show_seats_hold_consistency',
    );
  });

  it('rejects an expiry on a seat that is not HELD', async () => {
    const { showId, seatId } = await showWithSeat();
    await expectViolation(
      `INSERT INTO show_seats (show_id, seat_id, price_paise, status, held_until)
       VALUES ($1, $2, 22000, 'AVAILABLE', now() + interval '10 minutes')`,
      [showId, seatId],
      CHECK,
      'show_seats_hold_consistency',
    );
  });

  it('rejects an unknown seat status', async () => {
    const { showId, seatId } = await showWithSeat();
    // Both show_seats_status_valid and show_seats_hold_consistency reject this row;
    // Postgres reports whichever it checks first, so assert only that a CHECK fails.
    await expectViolation(
      "INSERT INTO show_seats (show_id, seat_id, price_paise, status) VALUES ($1, $2, 22000, 'RESERVED')",
      [showId, seatId],
      CHECK,
    );
  });

  it("deletes a show's prices and inventory with the show", async () => {
    const { showId, seatId } = await showWithSeat();
    const c = await category();
    await db.query(
      'INSERT INTO show_prices (show_id, category_id, price_paise) VALUES ($1, $2, 22000)',
      [showId, c.id],
    );
    await db.query(
      'INSERT INTO show_seats (show_id, seat_id, price_paise) VALUES ($1, $2, 22000)',
      [showId, seatId],
    );

    await db.query('DELETE FROM shows WHERE id = $1', [showId]);

    const prices = await db.query('SELECT 1 FROM show_prices WHERE show_id = $1', [showId]);
    const seats = await db.query('SELECT 1 FROM show_seats WHERE show_id = $1', [showId]);
    expect(prices.rowCount).toBe(0);
    expect(seats.rowCount).toBe(0);
  });
});

describe('updated_at', () => {
  it('is refreshed by the trigger on update', async () => {
    const c = await city();
    // now() is fixed for a whole transaction, so move created/updated into the past first.
    await db.query(
      "UPDATE cities SET created_at = now() - interval '1 day', updated_at = now() - interval '1 day' WHERE id = $1",
      [c.id],
    );
    const row = await one<{ fresh: boolean }>(
      "UPDATE cities SET name = 'Renamed' WHERE id = $1 RETURNING updated_at > created_at AS fresh",
      [c.id],
    );
    expect(row.fresh).toBe(true);
  });
});
