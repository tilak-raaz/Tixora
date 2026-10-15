import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  createLogger,
  createPool,
  createRedis,
  loadEnvFile,
  runMigrations,
  type Pool,
  type Redis,
} from '@bmt/platform';
import pg from 'pg';
import { loadConfig } from '../config';
import { AppError } from '../lib/errors';
import { createCatalogService } from '../modules/catalog/service';
import { createBookingService, DEFAULT_BOOKING_CONFIG } from '../modules/booking/service';
import {
  createRedisStrategy,
  createStrategy,
  HOLD_STRATEGIES,
  type HoldStrategyName,
  type RedisStrategyStats,
} from '../modules/booking/strategies';
import { ENV_FILE, MIGRATIONS_DIR, ROOT_DIR } from '../paths';

/**
 * `make bench`: every hold strategy against the same three scenarios, through
 * three "replicas" (separate Postgres pools and Redis clients), all requests
 * fired at once. Runs in a throwaway database that is dropped afterwards, and
 * checks the booking invariants after every run, so a fast but wrong strategy
 * fails loudly instead of winning. Results go to docs/benchmarks/.
 */

const REPLICAS = 3;
const POOL_PER_REPLICA = 10;
const RUNS = 3;
const OUTPUT = path.join(ROOT_DIR, 'docs', 'benchmarks', 'm2-hold-strategies.md');

interface Scenario {
  name: string;
  description: string;
  seats: number;
  buyers: number;
  /** Which seats buyer i asks for. */
  pick: (i: number, seatIds: string[]) => string[];
}

const SCENARIOS: Scenario[] = [
  {
    name: 'One hot seat',
    description: '300 buyers, 1 seat, everyone wants it',
    seats: 1,
    buyers: 300,
    pick: (_i, ids) => [ids[0]!],
  },
  {
    name: 'Hot row',
    description: '300 buyers, 20 seats, each wants 2 neighbouring seats',
    seats: 20,
    buyers: 300,
    pick: (i, ids) => {
      const start = i % (ids.length - 1);
      return [ids[start]!, ids[start + 1]!];
    },
  },
  {
    name: 'No contention',
    description: '300 buyers, 600 seats, each wants 2 seats nobody else wants',
    seats: 600,
    buyers: 300,
    pick: (i, ids) => [ids[2 * i]!, ids[2 * i + 1]!],
  },
];

interface RunResult {
  strategy: HoldStrategyName;
  held: number;
  refused: number;
  errors: number;
  rejectedByRedis: number;
  p50: number;
  p95: number;
  p99: number;
  wallMs: number;
}

loadEnvFile(ENV_FILE);
const config = loadConfig();
const logger = createLogger({ name: 'bench', level: 'info', pretty: true });
const quiet = createLogger({ name: 'bench', level: 'silent' });

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

async function makeShow(pool: Pool, seats: number): Promise<{ showId: string; seatIds: string[] }> {
  const catalog = createCatalogService(pool);
  const tag = Math.random().toString(36).slice(2, 10);
  const city = await catalog.createCity({
    name: `Bench ${tag}`,
    slug: `bench-${tag}`,
    state: 'Bench',
    timezone: 'Asia/Kolkata',
  });
  const category = await catalog.createSeatCategory({ name: `Tier ${tag}`, sortOrder: 0 });
  const theatre = await catalog.createTheatre({ cityId: city.id, name: 'Bench', address: 'x' });
  // Rows of up to 30 seats, labelled A, B, ... Z, AA, AB, ...
  const rows = Array.from({ length: Math.ceil(seats / 30) }, (_, r) => ({
    label: r < 26 ? String.fromCharCode(65 + r) : `A${String.fromCharCode(65 + r - 26)}`,
    categoryId: category.id,
    seats: Math.min(30, seats - r * 30),
    aisleAfter: [],
  }));
  const screen = await catalog.createScreen({ theatreId: theatre.id, name: 'Bench', rows });
  const movie = await catalog.createMovie({
    title: `Bench ${tag}`,
    language: 'None',
    durationMin: 120,
    releaseDate: '2026-01-01',
  });
  const show = await catalog.createShow({
    movieId: movie.id,
    screenId: screen.id,
    startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    prices: [{ categoryId: category.id, pricePaise: 20_000 }],
  });
  const { rows: seatRows } = await pool.query<{ id: string }>(
    `SELECT ss.id FROM show_seats ss JOIN seats s ON s.id = ss.seat_id
     WHERE ss.show_id = $1 ORDER BY s.grid_y, s.grid_x`,
    [show.id],
  );
  return { showId: show.id, seatIds: seatRows.map((r) => r.id) };
}

async function makeUsers(pool: Pool, count: number): Promise<string[]> {
  const tag = Math.random().toString(36).slice(2, 10);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (name, email)
     SELECT 'Bench', 'bench-' || $1 || '-' || g || '@example.com' FROM generate_series(1, $2) g
     RETURNING id`,
    [tag, count],
  );
  return rows.map((r) => r.id);
}

/** The guarantees no strategy may break. Throws on any violation. */
async function checkInvariants(pool: Pool, showId: string, held: number): Promise<void> {
  const { rows } = await pool.query<{ split: number; pending: number }>(
    `SELECT
       (SELECT count(*)::int FROM bookings b
        WHERE b.show_id = $1 AND
              (SELECT count(*) FROM booking_seats bs WHERE bs.booking_id = b.id) <>
              (SELECT count(*) FROM show_seats ss WHERE ss.booking_id = b.id AND ss.status = 'HELD')
       ) AS split,
       (SELECT count(*)::int FROM bookings WHERE show_id = $1 AND status = 'PENDING_PAYMENT') AS pending`,
    [showId],
  );
  const { split, pending } = rows[0]!;
  if (split !== 0)
    throw new Error(`invariant broken: ${split} bookings hold only part of their seats`);
  if (pending !== held)
    throw new Error(`invariant broken: ${held} holds reported, ${pending} in DB`);
}

async function runOnce(
  pools: Pool[],
  redisClients: Redis[],
  strategyName: HoldStrategyName,
  scenario: Scenario,
): Promise<RunResult> {
  const { showId, seatIds } = await makeShow(pools[0]!, scenario.seats);
  const users = await makeUsers(pools[0]!, scenario.buyers);
  const stats: RedisStrategyStats[] = [];
  const replicas = pools.map((pool, i) => {
    const strategy =
      strategyName === 'redis'
        ? createRedisStrategy(redisClients[i]!, quiet)
        : createStrategy(strategyName, { redis: redisClients[i]!, logger: quiet });
    if ('stats' in strategy) stats.push(strategy.stats as RedisStrategyStats);
    return createBookingService(
      pool,
      { ...DEFAULT_BOOKING_CONFIG, strategy: strategyName },
      strategy,
    );
  });

  const latencies: number[] = [];
  let held = 0;
  let refused = 0;
  let errors = 0;
  const start = performance.now();
  await Promise.all(
    users.map(async (userId, i) => {
      const t0 = performance.now();
      try {
        await replicas[i % REPLICAS]!.hold(userId, { showId, seatIds: scenario.pick(i, seatIds) });
        held += 1;
      } catch (err) {
        if (err instanceof AppError && err.code === 'SEATS_UNAVAILABLE') refused += 1;
        else {
          errors += 1;
          logger.error({ err }, 'unexpected error');
        }
      } finally {
        latencies.push(performance.now() - t0);
      }
    }),
  );
  const wallMs = performance.now() - start;

  await checkInvariants(pools[0]!, showId, held);
  latencies.sort((a, b) => a - b);
  return {
    strategy: strategyName,
    held,
    refused,
    errors,
    rejectedByRedis: stats.reduce((sum, s) => sum + s.rejectedByRedis, 0),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    wallMs,
  };
}

const ms = (n: number) => n.toFixed(1);

function table(results: RunResult[]): string {
  const lines = [
    '| Strategy | Held | Refused | Errors | Stopped by Redis | p50 ms | p95 ms | p99 ms | Wall ms |',
    '| --- | --: | --: | --: | --: | --: | --: | --: | --: |',
  ];
  for (const r of results) {
    lines.push(
      `| ${r.strategy} | ${r.held} | ${r.refused} | ${r.errors} | ${r.strategy === 'redis' ? r.rejectedByRedis : '–'} | ${ms(r.p50)} | ${ms(r.p95)} | ${ms(r.p99)} | ${ms(r.wallMs)} |`,
    );
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const admin = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1 });
  const dbName = `bmt_bench_${Date.now()}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(config.DATABASE_URL);
  url.pathname = `/${dbName}`;

  const pools = Array.from({ length: REPLICAS }, (_, i) =>
    createPool({
      connectionString: url.toString(),
      max: POOL_PER_REPLICA,
      applicationName: `bmt-bench-${i + 1}`,
      logger: quiet,
    }),
  );
  const redisClients = pools.map(() => createRedis(config.REDIS_URL, quiet));

  try {
    await runMigrations(pools[0]!, MIGRATIONS_DIR);
    const pgVersion = (
      await pools[0]!.query<{ v: string }>("SELECT current_setting('server_version') AS v")
    ).rows[0]!.v;
    const redisInfo = await redisClients[0]!.info('server');
    const redisVersion = /redis_version:(\S+)/.exec(redisInfo)?.[1] ?? 'unknown';

    const sections: string[] = [];
    for (const scenario of SCENARIOS) {
      logger.info({ scenario: scenario.name }, 'running');
      const results: RunResult[] = [];
      for (const strategy of HOLD_STRATEGIES) {
        await runOnce(pools, redisClients, strategy, { ...scenario, buyers: 30 }); // warm-up
        const runs: RunResult[] = [];
        for (let i = 0; i < RUNS; i++)
          runs.push(await runOnce(pools, redisClients, strategy, scenario));
        runs.sort((a, b) => a.wallMs - b.wallMs);
        results.push(runs[Math.floor(RUNS / 2)]!); // the median run
      }
      sections.push(`### ${scenario.name}\n\n${scenario.description}.\n\n${table(results)}`);
    }

    const cpus = os.cpus();
    const report = `# M2 benchmark: seat hold strategies

Generated by \`make bench\` on ${new Date().toISOString().slice(0, 10)}. Each scenario fires every
request at once through ${REPLICAS} replicas (${POOL_PER_REPLICA} Postgres connections each). The
table shows the median of ${RUNS} runs after a warm-up. After every run the script checks that no
booking holds only part of its seats and that every reported hold exists in the database.

- **Machine:** ${cpus[0]?.model ?? 'unknown'} (${cpus.length} cores), ${Math.round(os.totalmem() / 2 ** 30)} GB RAM, ${os.platform()} ${os.release()}
- **Software:** Node.js ${process.version}, PostgreSQL ${pgVersion}, Redis ${redisVersion}, all on one machine (Docker)
- **Refused** is a clean 409 \`SEATS_UNAVAILABLE\`; **Errors** is anything else (must be 0)
- **Stopped by Redis** counts refusals that never opened a Postgres transaction

${sections.join('\n\n')}

## Reading the numbers

Latency is the time one buyer waits, including queueing for a connection, so contention shows up
as p95/p99 growth rather than failures. Numbers from a laptop are for comparing strategies with
each other, not for capacity planning; M7 repeats this through nginx and real HTTP.
`;
    await writeFile(OUTPUT, report);
    logger.info({ file: path.relative(ROOT_DIR, OUTPUT) }, 'benchmark written');
  } finally {
    await Promise.all(pools.map((p) => p.end()));
    await Promise.all(redisClients.map((r) => r.quit()));
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
}

try {
  await main();
} catch (err) {
  logger.fatal({ err }, 'benchmark failed');
  process.exitCode = 1;
}
