import { createLogger, createPool, loadEnvFile } from '@bmt/platform';
import { loadConfig } from '../config';
import { AppError } from '../lib/errors';
import { createCatalogService } from '../modules/catalog/service';
import { ENV_FILE } from '../paths';

/**
 * `make seed`: one city, three seat tiers, three theatres with five screens, ten movies, and four
 * shows a day per screen for the next 7 days. Goes through the catalog service, so seeded data
 * obeys the same rules as admin-created data.
 *
 * Safe to run again: it creates only what is missing (by name), then adds the shows missing from
 * the next 7 days. So it also brings an older database up to date: the deployed stack runs it once
 * a day, and the demo never runs out of shows.
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

const DAYS = 7;
const SHOW_TIMES_IST = ['10:00', '13:30', '17:00', '20:30'];
const TIERS = ['Recliner', 'Prime', 'Classic'] as const;
type Tier = (typeof TIERS)[number];
const TIER_PRICE_PAISE: Record<Tier, number> = { Recliner: 55_000, Prime: 28_000, Classic: 22_000 };

const CITY = { name: 'Rourkela', slug: 'rourkela', state: 'Odisha', timezone: 'Asia/Kolkata' };

/** A screen's rows: [labels, tier, seats per row, aisle after these seat numbers]. */
type RowSpec = [labels: string[], tier: Tier, seats: number, aisleAfter: number[]];

const THEATRES: { name: string; address: string; screens: { name: string; rows: RowSpec[] }[] }[] =
  [
    {
      name: 'Riverside Multiplex',
      address: 'Panposh Road, Rourkela',
      screens: [
        {
          name: 'Screen 1',
          rows: [
            [['A', 'B', 'C', 'D', 'E'], 'Classic', 12, [6]],
            [['F', 'G'], 'Prime', 12, [6]],
            [['H'], 'Recliner', 8, [4]],
          ],
        },
      ],
    },
    {
      name: 'Steel City Cinemas',
      address: 'Udit Nagar, Rourkela',
      screens: [
        {
          name: 'Audi 1',
          rows: [
            [['A', 'B', 'C', 'D', 'E', 'F'], 'Classic', 14, [7]],
            [['G', 'H'], 'Prime', 14, [7]],
            [['J'], 'Recliner', 8, [4]],
          ],
        },
        {
          name: 'Audi 2',
          rows: [
            [['A', 'B', 'C', 'D'], 'Classic', 10, [5]],
            [['E', 'F'], 'Prime', 10, [5]],
            [['G'], 'Recliner', 6, [3]],
          ],
        },
      ],
    },
    {
      name: 'Panposh Talkies',
      address: 'Sector 19, Rourkela',
      screens: [
        {
          name: 'Hall A',
          rows: [
            [['A', 'B', 'C', 'D', 'E'], 'Classic', 10, [5]],
            [['F', 'G'], 'Prime', 10, [5]],
            [['H'], 'Recliner', 6, [3]],
          ],
        },
        {
          name: 'Hall B',
          rows: [
            [['A', 'B', 'C', 'D'], 'Classic', 8, [4]],
            [['E'], 'Prime', 8, [4]],
            [['F'], 'Recliner', 4, [2]],
          ],
        },
      ],
    },
  ];

// Fictional titles. Longest is 150 min; + 15 min cleaning fits the 3.5 h slots.
const MOVIES: {
  title: string;
  language: string;
  durationMin: number;
  certificate: string;
  releasedDaysAgo: number;
  description: string;
}[] = [
  {
    title: 'Monsoon Express',
    language: 'Hindi',
    durationMin: 142,
    certificate: 'UA13+',
    releasedDaysAgo: 10,
    description: 'A night train, a missing ledger and nine suspects.',
  },
  {
    title: 'The Last Lighthouse',
    language: 'English',
    durationMin: 118,
    certificate: 'UA7+',
    releasedDaysAgo: 3,
    description: 'A keeper refuses to leave the island the sea is taking back.',
  },
  {
    title: 'Kalinga Rising',
    language: 'Odia',
    durationMin: 150,
    certificate: 'UA16+',
    releasedDaysAgo: 20,
    description: 'Two brothers on opposite sides of an ancient war.',
  },
  {
    title: 'Brahmani Blues',
    language: 'Odia',
    durationMin: 134,
    certificate: 'UA13+',
    releasedDaysAgo: 6,
    description: 'A river-town band gets one night to win back its old stage.',
  },
  {
    title: 'Last Bus to Sambalpur',
    language: 'Hindi',
    durationMin: 128,
    certificate: 'UA7+',
    releasedDaysAgo: 14,
    description: 'Six strangers, one broken-down bus and a wedding nobody can miss.',
  },
  {
    title: 'Kite Season',
    language: 'English',
    durationMin: 104,
    certificate: 'U',
    releasedDaysAgo: 2,
    description: 'Two kids plan to win the rooftop kite contest their fathers never could.',
  },
  {
    title: 'The Ninth Over',
    language: 'Hindi',
    durationMin: 147,
    certificate: 'UA13+',
    releasedDaysAgo: 8,
    description: 'A small-town bowler gets one over to save a career and a club.',
  },
  {
    title: 'Steel & Smoke',
    language: 'English',
    durationMin: 139,
    certificate: 'A',
    releasedDaysAgo: 12,
    description: 'A plant inspector finds a shift that is not on any roster.',
  },
  {
    title: 'Chai at Midnight',
    language: 'Hindi',
    durationMin: 112,
    certificate: 'UA7+',
    releasedDaysAgo: 4,
    description: 'A tea stall stays open all night, and everyone who stops has a story.',
  },
  {
    title: 'Hirakud Nights',
    language: 'Odia',
    durationMin: 121,
    certificate: 'UA13+',
    releasedDaysAgo: 1,
    description: 'A lake, a lantern festival and a letter delivered twenty years late.',
  },
];

/** YYYY-MM-DD in India, `daysAhead` days from now. */
function istDate(daysAhead: number): string {
  const when = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(when);
}

/** The id of the row matching `sql`, or the id `create` returns (and `created` counts it). */
async function ensure(
  counts: Record<string, number>,
  kind: string,
  sql: string,
  params: unknown[],
  create: () => Promise<{ id: string }>,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(sql, params);
  if (rows[0]) return rows[0].id;
  counts[kind] = (counts[kind] ?? 0) + 1;
  return (await create()).id;
}

type Prices = { categoryId: string; pricePaise: number }[];

/**
 * Four shows a day on every screen for the next DAYS days, skipping times already past and slots
 * that already have a show. Each day steps through the movies across screens and times, so with
 * 20 slots a day every movie plays at least once. Returns how many it created.
 */
async function addShows(screenIds: string[], movieIds: string[], prices: Prices): Promise<number> {
  let created = 0;
  for (let day = 0; day < DAYS; day++) {
    const date = istDate(day);
    for (const [s, screenId] of screenIds.entries()) {
      for (const [t, time] of SHOW_TIMES_IST.entries()) {
        const startsAt = `${date}T${time}:00+05:30`;
        if (Date.parse(startsAt) <= Date.now()) continue; // earlier today
        const slot = s * SHOW_TIMES_IST.length + t + day;
        try {
          await catalog.createShow({
            movieId: movieIds[slot % movieIds.length]!,
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

async function seed(): Promise<void> {
  const created: Record<string, number> = {};

  const categoryIds = {} as Record<Tier, string>;
  for (const [sortOrder, name] of TIERS.entries()) {
    categoryIds[name] = await ensure(
      created,
      'seatCategories',
      'SELECT id FROM seat_categories WHERE name = $1',
      [name],
      () => catalog.createSeatCategory({ name, sortOrder }),
    );
  }
  const prices: Prices = TIERS.map((tier) => ({
    categoryId: categoryIds[tier],
    pricePaise: TIER_PRICE_PAISE[tier],
  }));

  const cityId = await ensure(
    created,
    'cities',
    'SELECT id FROM cities WHERE slug = $1',
    [CITY.slug],
    () => catalog.createCity(CITY),
  );

  const screenIds: string[] = [];
  for (const theatre of THEATRES) {
    const theatreId = await ensure(
      created,
      'theatres',
      'SELECT id FROM theatres WHERE city_id = $1 AND name = $2',
      [cityId, theatre.name],
      () => catalog.createTheatre({ cityId, name: theatre.name, address: theatre.address }),
    );
    for (const screen of theatre.screens) {
      const rows = screen.rows.flatMap(([labels, tier, seats, aisleAfter]) =>
        labels.map((label) => ({ label, categoryId: categoryIds[tier], seats, aisleAfter })),
      );
      screenIds.push(
        await ensure(
          created,
          'screens',
          'SELECT id FROM screens WHERE theatre_id = $1 AND name = $2',
          [theatreId, screen.name],
          () => catalog.createScreen({ theatreId, name: screen.name, rows }),
        ),
      );
    }
  }

  const movieIds: string[] = [];
  for (const { releasedDaysAgo, ...movie } of MOVIES) {
    movieIds.push(
      await ensure(
        created,
        'movies',
        'SELECT id FROM movies WHERE title = $1 AND language = $2 ORDER BY release_date LIMIT 1',
        [movie.title, movie.language],
        () => catalog.createMovie({ ...movie, releaseDate: istDate(-releasedDaysAgo) }),
      ),
    );
  }

  const shows = await addShows(screenIds, movieIds, prices);
  logger.info(
    { city: CITY.slug, screens: screenIds.length, movies: movieIds.length, created, shows },
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
