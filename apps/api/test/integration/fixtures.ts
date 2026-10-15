import { randomUUID } from 'node:crypto';
import type { Pool } from '@bmt/platform';
import { createCatalogService } from '../../src/modules/catalog/service';

/**
 * A show two days from now with one row of `seats` seats at ₹200 each, on its
 * own new screen so tests never clash. Built through the catalog service, so it
 * obeys the same rules as real data. Seat ids come back in seat-number order.
 */
export async function createShowFixture(
  pool: Pool,
  seats = 10,
): Promise<{ showId: string; seatIds: string[] }> {
  const catalog = createCatalogService(pool);
  const tag = randomUUID().slice(0, 8);

  const city = await catalog.createCity({
    name: `City ${tag}`,
    slug: `city-${tag}`,
    state: 'Odisha',
    timezone: 'Asia/Kolkata',
  });
  const category = await catalog.createSeatCategory({ name: `Tier ${tag}`, sortOrder: 0 });
  const theatre = await catalog.createTheatre({
    cityId: city.id,
    name: `Theatre ${tag}`,
    address: 'Main Road',
  });
  const screen = await catalog.createScreen({
    theatreId: theatre.id,
    name: 'Audi 1',
    rows: [{ label: 'A', categoryId: category.id, seats, aisleAfter: [] }],
  });
  const movie = await catalog.createMovie({
    title: `Movie ${tag}`,
    language: 'Hindi',
    durationMin: 120,
    releaseDate: '2026-06-01',
  });
  const show = await catalog.createShow({
    movieId: movie.id,
    screenId: screen.id,
    startsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
    prices: [{ categoryId: category.id, pricePaise: 20_000 }],
  });

  const { rows } = await pool.query<{ id: string }>(
    `SELECT ss.id FROM show_seats ss JOIN seats s ON s.id = ss.seat_id
     WHERE ss.show_id = $1 ORDER BY s.seat_number`,
    [show.id],
  );
  return { showId: show.id, seatIds: rows.map((r) => r.id) };
}

/** `count` users inserted directly (no passwords): enough for service-level tests. */
export async function createUsers(pool: Pool, count: number): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (name, email)
     SELECT 'Buyer ' || g, 'buyer-' || $1 || '-' || g || '@example.com'
     FROM generate_series(1, $2) AS g
     RETURNING id`,
    [randomUUID(), count],
  );
  return rows.map((r) => r.id);
}
