import { createLogger, createPool, loadEnvFile } from '@bmt/platform';
import { loadConfig } from '../config';
import { createCatalogService } from '../modules/catalog/service';
import { ENV_FILE } from '../paths';

/**
 * `make seed`: one city, three seat tiers, two theatres with three screens, three
 * movies, and four shows a day per screen for the next 7 days. Goes through the
 * catalog service, so seeded data obeys the same rules as admin-created data.
 * Runs once: if the city exists already, it does nothing.
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

async function seed(): Promise<void> {
  const already = await pool.query('SELECT 1 FROM cities WHERE slug = $1', [CITY_SLUG]);
  if (already.rowCount) {
    logger.info({ city: CITY_SLUG }, 'already seeded; nothing to do (make reset to start over)');
    return;
  }

  const recliner = await seatCategory('Recliner', 0);
  const prime = await seatCategory('Prime', 1);
  const classic = await seatCategory('Classic', 2);
  const prices = [
    { categoryId: recliner, pricePaise: 55_000 },
    { categoryId: prime, pricePaise: 28_000 },
    { categoryId: classic, pricePaise: 22_000 },
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

  let showCount = 0;
  for (let day = 0; day < DAYS; day++) {
    const date = istDate(day);
    for (const [s, screen] of screens.entries()) {
      for (const [t, time] of SHOW_TIMES_IST.entries()) {
        const startsAt = `${date}T${time}:00+05:30`;
        if (Date.parse(startsAt) <= Date.now()) continue; // earlier today
        const movie = movies[(s + t + day) % movies.length]!;
        await catalog.createShow({
          movieId: movie.id,
          screenId: screen.id,
          startsAt,
          prices,
        });
        showCount++;
      }
    }
  }

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
