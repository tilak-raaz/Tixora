import type { Pool, PoolClient } from '@bmt/platform';

/** Repo functions run on the pool or inside a transaction's client. */
type Db = Pool | PoolClient;

// Columns are aliased to camelCase so rows go to the client as-is. Dates are
// cast to text: node-postgres turns a `date` into a JS Date at local midnight,
// which shifts the day for anyone west of the server.

// ---------- writes ----------

export async function insertCity(
  db: Db,
  city: { name: string; slug: string; state: string; timezone: string },
) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO cities (name, slug, state, timezone) VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [city.name, city.slug, city.state, city.timezone],
  );
  return rows[0]!;
}

export async function insertSeatCategory(db: Db, category: { name: string; sortOrder: number }) {
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO seat_categories (name, sort_order) VALUES ($1, $2) RETURNING id',
    [category.name, category.sortOrder],
  );
  return rows[0]!;
}

export async function insertTheatre(
  db: Db,
  theatre: { cityId: string; name: string; address: string },
) {
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO theatres (city_id, name, address) VALUES ($1, $2, $3) RETURNING id',
    [theatre.cityId, theatre.name, theatre.address],
  );
  return rows[0]!;
}

export async function insertScreen(db: Db, screen: { theatreId: string; name: string }) {
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO screens (theatre_id, name) VALUES ($1, $2) RETURNING id',
    [screen.theatreId, screen.name],
  );
  return rows[0]!;
}

export interface SeatRow {
  categoryId: string;
  rowLabel: string;
  seatNumber: number;
  gridX: number;
  gridY: number;
}

/** One INSERT for the whole layout, however many seats it has. */
export async function insertSeats(db: Db, screenId: string, seats: SeatRow[]): Promise<number> {
  const { rowCount } = await db.query(
    `INSERT INTO seats (screen_id, category_id, row_label, seat_number, grid_x, grid_y)
     SELECT $1, * FROM unnest($2::uuid[], $3::text[], $4::int[], $5::int[], $6::int[])`,
    [
      screenId,
      seats.map((s) => s.categoryId),
      seats.map((s) => s.rowLabel),
      seats.map((s) => s.seatNumber),
      seats.map((s) => s.gridX),
      seats.map((s) => s.gridY),
    ],
  );
  return rowCount ?? 0;
}

export async function insertMovie(
  db: Db,
  movie: {
    title: string;
    language: string;
    durationMin: number;
    certificate?: string | undefined;
    releaseDate: string;
    description?: string | undefined;
    posterUrl?: string | undefined;
  },
) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO movies (title, language, duration_min, certificate, release_date, description, poster_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      movie.title,
      movie.language,
      movie.durationMin,
      movie.certificate ?? null,
      movie.releaseDate,
      movie.description ?? null,
      movie.posterUrl ?? null,
    ],
  );
  return rows[0]!;
}

export async function findMovieDuration(db: Db, movieId: string): Promise<number | undefined> {
  const { rows } = await db.query<{ duration_min: number }>(
    'SELECT duration_min FROM movies WHERE id = $1',
    [movieId],
  );
  return rows[0]?.duration_min;
}

/** Seat categories used by a screen's active seats; each one needs a price. */
export async function findScreenCategoryIds(
  db: Db,
  screenId: string,
): Promise<string[] | undefined> {
  const screen = await db.query('SELECT 1 FROM screens WHERE id = $1 AND is_active', [screenId]);
  if (screen.rowCount === 0) return undefined;
  const { rows } = await db.query<{ category_id: string }>(
    'SELECT DISTINCT category_id FROM seats WHERE screen_id = $1 AND is_active',
    [screenId],
  );
  return rows.map((r) => r.category_id);
}

/** ends_at = starts_at + the given minutes, computed by Postgres. */
export async function insertShow(
  db: Db,
  show: { movieId: string; screenId: string; startsAt: string; occupiesMin: number },
) {
  const { rows } = await db.query<{ id: string; startsAt: Date; endsAt: Date }>(
    `INSERT INTO shows (movie_id, screen_id, starts_at, ends_at)
     VALUES ($1, $2, $3::timestamptz, $3::timestamptz + make_interval(mins => $4::int))
     RETURNING id, starts_at AS "startsAt", ends_at AS "endsAt"`,
    [show.movieId, show.screenId, show.startsAt, show.occupiesMin],
  );
  return rows[0]!;
}

export async function insertShowPrices(
  db: Db,
  showId: string,
  prices: { categoryId: string; pricePaise: number }[],
) {
  await db.query(
    `INSERT INTO show_prices (show_id, category_id, price_paise)
     SELECT $1, * FROM unnest($2::uuid[], $3::int[])`,
    [showId, prices.map((p) => p.categoryId), prices.map((p) => p.pricePaise)],
  );
}

/** Creates the show's seat inventory: one AVAILABLE row per active seat, priced by category. */
export async function insertShowSeats(db: Db, showId: string, screenId: string): Promise<number> {
  const { rowCount } = await db.query(
    `INSERT INTO show_seats (show_id, seat_id, price_paise)
     SELECT $1, s.id, sp.price_paise
     FROM seats s
     JOIN show_prices sp ON sp.show_id = $1 AND sp.category_id = s.category_id
     WHERE s.screen_id = $2 AND s.is_active`,
    [showId, screenId],
  );
  return rowCount ?? 0;
}

// ---------- reads ----------

/**
 * A seat is free if it is AVAILABLE or its hold has run out. Expired holds are
 * released by the sweeper in M2; until it runs they must not look taken.
 */
const SEAT_IS_FREE = `(ss.status = 'AVAILABLE' OR (ss.status = 'HELD' AND ss.held_until <= now()))`;

/**
 * Shows that start on a calendar date in the city's time zone ($date, or today
 * there when null), and have not started yet. Expects aliases c (city) and sh (show).
 */
const ON_CITY_DATE = `
  sh.status = 'SCHEDULED'
  AND sh.starts_at > now()
  AND sh.starts_at >= (COALESCE($2::date, (now() AT TIME ZONE c.timezone)::date))::timestamp AT TIME ZONE c.timezone
  AND sh.starts_at <  (COALESCE($2::date, (now() AT TIME ZONE c.timezone)::date) + 1)::timestamp AT TIME ZONE c.timezone`;

export async function listCities(db: Db) {
  const { rows } = await db.query(
    'SELECT id, name, slug, state, timezone FROM cities ORDER BY name',
  );
  return rows;
}

export async function cityExists(db: Db, slug: string): Promise<boolean> {
  const { rowCount } = await db.query('SELECT 1 FROM cities WHERE slug = $1', [slug]);
  return rowCount === 1;
}

const MOVIE_COLUMNS = `m.id, m.title, m.language, m.duration_min AS "durationMin", m.certificate,
  m.release_date::text AS "releaseDate", m.description, m.poster_url AS "posterUrl"`;

export async function listMoviesInCity(db: Db, citySlug: string, date: string | null) {
  const { rows } = await db.query(
    `SELECT DISTINCT ${MOVIE_COLUMNS}
     FROM cities c
     JOIN theatres t ON t.city_id = c.id AND t.is_active
     JOIN screens sc ON sc.theatre_id = t.id AND sc.is_active
     JOIN shows sh ON sh.screen_id = sc.id
     JOIN movies m ON m.id = sh.movie_id
     WHERE c.slug = $1 AND ${ON_CITY_DATE}
     ORDER BY m.title`,
    [citySlug, date],
  );
  return rows;
}

export async function findMovie(db: Db, movieId: string) {
  const { rows } = await db.query(`SELECT ${MOVIE_COLUMNS} FROM movies m WHERE m.id = $1`, [
    movieId,
  ]);
  return rows[0];
}

export interface MovieShowRow {
  theatreId: string;
  theatreName: string;
  address: string;
  showId: string;
  screenName: string;
  startsAt: Date;
  availableSeats: number;
}

export async function listShowsForMovie(
  db: Db,
  movieId: string,
  citySlug: string,
  date: string | null,
) {
  const { rows } = await db.query<MovieShowRow>(
    `SELECT t.id AS "theatreId", t.name AS "theatreName", t.address,
            sh.id AS "showId", sc.name AS "screenName", sh.starts_at AS "startsAt",
            (SELECT count(*)::int FROM show_seats ss
             WHERE ss.show_id = sh.id AND ${SEAT_IS_FREE}) AS "availableSeats"
     FROM cities c
     JOIN theatres t ON t.city_id = c.id AND t.is_active
     JOIN screens sc ON sc.theatre_id = t.id AND sc.is_active
     JOIN shows sh ON sh.screen_id = sc.id AND sh.movie_id = $3
     WHERE c.slug = $1 AND ${ON_CITY_DATE}
     ORDER BY t.name, sh.starts_at`,
    [citySlug, date, movieId],
  );
  return rows;
}

export async function findShow(db: Db, showId: string) {
  const { rows } = await db.query(
    `SELECT sh.id, sh.status, sh.starts_at AS "startsAt", sh.ends_at AS "endsAt",
            json_build_object('id', m.id, 'title', m.title, 'language', m.language,
                              'durationMin', m.duration_min, 'certificate', m.certificate) AS movie,
            json_build_object('id', t.id, 'name', t.name, 'address', t.address) AS theatre,
            json_build_object('id', sc.id, 'name', sc.name) AS screen,
            c.timezone,
            (SELECT json_agg(json_build_object('categoryId', cat.id, 'category', cat.name,
                                               'pricePaise', sp.price_paise)
                             ORDER BY cat.sort_order, cat.name)
             FROM show_prices sp JOIN seat_categories cat ON cat.id = sp.category_id
             WHERE sp.show_id = sh.id) AS prices
     FROM shows sh
     JOIN movies m ON m.id = sh.movie_id
     JOIN screens sc ON sc.id = sh.screen_id
     JOIN theatres t ON t.id = sc.theatre_id
     JOIN cities c ON c.id = t.city_id
     WHERE sh.id = $1`,
    [showId],
  );
  return rows[0];
}

/**
 * The seat map. Clients only learn AVAILABLE or UNAVAILABLE: whether a taken
 * seat is held or booked, and by whom, is nobody else's business.
 */
export async function listSeatMap(db: Db, showId: string) {
  const { rows } = await db.query(
    `SELECT ss.id, s.row_label AS row, s.seat_number AS number, s.grid_x AS x, s.grid_y AS y,
            cat.name AS category, ss.price_paise AS "pricePaise",
            CASE WHEN ${SEAT_IS_FREE} THEN 'AVAILABLE' ELSE 'UNAVAILABLE' END AS status
     FROM show_seats ss
     JOIN seats s ON s.id = ss.seat_id
     JOIN seat_categories cat ON cat.id = s.category_id
     WHERE ss.show_id = $1
     ORDER BY s.grid_y, s.grid_x`,
    [showId],
  );
  return rows;
}
