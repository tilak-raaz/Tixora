import { createLogger, createPool, loadEnvFile } from '@bmt/platform';
import { loadConfig } from '../config';
import { AppError } from '../lib/errors';
import { createCatalogService } from '../modules/catalog/service';
import { ENV_FILE } from '../paths';

/**
 * `make seed`: one city, three seat tiers, two theatres with three screens, three
 * movies, and four shows a day per screen for the next 7 days. Goes through the
 * catalog service, so seeded data obeys the same rules as admin-created data.
 *
 * Safe to run again: if the city exists already, it only adds the shows missing from the next 7
 * days. The deployed stack runs it once a day, so the demo never runs out of shows.
 */
loadEnvFile(ENV_FILE);
const config = loadConfig();
const logger = createLogger({
  name: 'seed',
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === 'development',
});
const pool = createPool({
  connectionString: config.DATABASE_URL,
  max: 2,
  applicationName: 'bmt-seed',
  logger,
});
const catalog = createCatalogService(pool);

const CITY_SLUG = 'rourkela';
const DAYS = 7;
const SHOW_TIMES_IST = ['10:00', '13:30', '17:00', '20:30'];
const MOVIE_TITLES = ['Monsoon Express', 'The Last Lighthouse', 'Kalinga Rising'];
const TIERS = ['Recliner', 'Prime', 'Classic'] as const;
const TIER_PRICE_PAISE = { Recliner: 55_000, Prime: 28_000, Classic: 22_000 };

/** YYYY-MM-DD in India, `daysAhead` days from now. */
function istDate(daysAhead: number): string {
  const when = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(when);
}

async function seatCategory(name: string, sortOrder: number): Promise<string> {
  const existing = await pool.query<{ id: string }>(
    'SELECT id FROM seat_categories WHERE name = $1',
    [name],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  return (await catalog.createSeatCategory({ name, sortOrder })).id;
}

type Prices = { categoryId: string; pricePaise: number }[];

/**
 * Four shows a day on every screen for the next DAYS days, rotating the movies, skipping times
 * already past and slots that already have a show. Returns how many it created.
 */
async function addShows(screenIds: string[], movieIds: string[], prices: Prices): Promise<number> {
  let created = 0;
  for (let day = 0; day < DAYS; day++) {
    const date = istDate(day);
    for (const [s, screenId] of screenIds.entries()) {
      for (const [t, time] of SHOW_TIMES_IST.entries()) {
        const startsAt = `${date}T${time}:00+05:30`;
        if (Date.parse(startsAt) <= Date.now()) continue; // earlier today
        try {
          await catalog.createShow({
            movieId: movieIds[(s + t + day) % movieIds.length]!,
            screenId,
            startsAt,
            prices,
          });
          created++;
        } catch (err) {
          // The screen already has a show then: added by an earlier run.
          if (err instanceof AppError && err.status === 409) continue;
          throw err;
        }
      }
    }
  }
  return created;
}

/** The city exists: add the shows missing from the coming week, nothing else. */
async function topUp(): Promise<void> {
  const screens = await pool.query<{ id: string }>(
    `SELECT sc.id FROM screens sc
     JOIN theatres t ON t.id = sc.theatre_id
     JOIN cities c ON c.id = t.city_id
     WHERE c.slug = $1
     ORDER BY t.name DESC, sc.name`,
    [CITY_SLUG],
  );
  const movies = await pool.query<{ id: string }>(
    'SELECT id FROM movies WHERE title = ANY($1) ORDER BY array_position($1, title)',
    [MOVIE_TITLES],
  );
  const prices: Prices = [];
  for (const [i, tier] of TIERS.entries()) {
    prices.push({ categoryId: await seatCategory(tier, i), pricePaise: TIER_PRICE_PAISE[tier] });
  }
  const shows = await addShows(
    screens.rows.map((r) => r.id),
    movies.rows.map((r) => r.id),
    prices,
  );
  logger.info({ city: CITY_SLUG, shows }, 'already seeded; added the missing shows for the week');
}

async function seed(): Promise<void> {
  const already = await pool.query('SELECT 1 FROM cities WHERE slug = $1', [CITY_SLUG]);
  if (already.rowCount) {
    await topUp();
    return;
  }

  const [recliner, prime, classic] = [
    await seatCategory('Recliner', 0),
    await seatCategory('Prime', 1),
    await seatCategory('Classic', 2),
  ];
  const prices: Prices = [
    { categoryId: recliner, pricePaise: TIER_PRICE_PAISE.Recliner },
    { categoryId: prime, pricePaise: TIER_PRICE_PAISE.Prime },
    { categoryId: classic, pricePaise: TIER_PRICE_PAISE.Classic },
  ];

  const city = await catalog.createCity({
    name: 'Rourkela',
    slug: CITY_SLUG,
    state: 'Odisha',
    timezone: 'Asia/Kolkata',
  });

  const steelCity = await catalog.createTheatre({
    cityId: city.id,
    name: 'Steel City Cinemas',
    address: 'Udit Nagar, Rourkela',
  });
  const riverside = await catalog.createTheatre({
    cityId: city.id,
    name: 'Riverside Multiplex',
    address: 'Panposh Road, Rourkela',
  });

  const row = (label: string, categoryId: string, seats: number, aisleAfter: number[]) => ({
    label,
    categoryId,
    seats,
    aisleAfter,
  });

  const screens = [
    await catalog.createScreen({
      theatreId: steelCity.id,
      name: 'Audi 1',
      rows: [
        ...['A', 'B', 'C', 'D', 'E', 'F'].map((l) => row(l, classic, 14, [7])),
        ...['G', 'H'].map((l) => row(l, prime, 14, [7])),
        row('J', recliner, 8, [4]),
      ],
    }),
    await catalog.createScreen({
      theatreId: steelCity.id,
      name: 'Audi 2',
      rows: [
        ...['A', 'B', 'C', 'D'].map((l) => row(l, classic, 10, [5])),
        ...['E', 'F'].map((l) => row(l, prime, 10, [5])),
        row('G', recliner, 6, [3]),
      ],
    }),
    await catalog.createScreen({
      theatreId: riverside.id,
      name: 'Screen 1',
      rows: [
        ...['A', 'B', 'C', 'D', 'E'].map((l) => row(l, classic, 12, [6])),
        ...['F', 'G'].map((l) => row(l, prime, 12, [6])),
        row('H', recliner, 8, [4]),
      ],
    }),
  ];

  // Fictional titles. Longest is 150 min; + 15 min cleaning fits the 3.5 h slots.
  const movies = [
    await catalog.createMovie({
      title: 'Monsoon Express',
      language: 'Hindi',
      durationMin: 142,
      certificate: 'UA13+',
      releaseDate: istDate(-10),
      description: 'A night train, a missing ledger and nine suspects.',
    }),
    await catalog.createMovie({
      title: 'The Last Lighthouse',
      language: 'English',
      durationMin: 118,
      certificate: 'UA7+',
      releaseDate: istDate(-3),
      description: 'A keeper refuses to leave the island the sea is taking back.',
    }),
    await catalog.createMovie({
      title: 'Kalinga Rising',
      language: 'Odia',
      durationMin: 150,
      certificate: 'UA16+',
      releaseDate: istDate(-20),
      description: 'Two brothers on opposite sides of an ancient war.',
    }),
  ];

  const showCount = await addShows(
    screens.map((s) => s.id),
    movies.map((m) => m.id),
    prices,
  );

  logger.info(
    {
      city: CITY_SLUG,
      theatres: 2,
      screens: screens.length,
      seats: screens.reduce((sum, s) => sum + s.seatCount, 0),
      movies: movies.length,
      shows: showCount,
    },
    'seed complete',
  );
}

try {
  await seed();
} catch (err) {
  logger.fatal({ err }, 'seed failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
