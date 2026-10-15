import { createLogger, createPool, createRedis, type Pool, type Redis } from '@bmt/platform';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppError } from '../../src/lib/errors';
import {
  createBookingService,
  DEFAULT_BOOKING_CONFIG,
  type BookingService,
} from '../../src/modules/booking/service';
import { createStrategy, HOLD_STRATEGIES } from '../../src/modules/booking/strategies';
import { createShowFixture, createUsers } from './fixtures';

/**
 * The core claim of the project: under contention, a seat goes to exactly one
 * buyer. Three independent services, each with its own Postgres pool and Redis
 * client, stand in for three API replicas. Every hold strategy must pass the
 * same suite.
 */

const logger = createLogger({ name: 'test', level: 'silent' });
let pool: Pool;
let replicaPools: Pool[];
let replicaRedis: Redis[];

beforeAll(() => {
  const connect = (applicationName: string) =>
    createPool({ connectionString: inject('databaseUrl'), max: 10, applicationName, logger });
  pool = connect('bmt-test');
  replicaPools = ['replica-1', 'replica-2', 'replica-3'].map(connect);
  replicaRedis = replicaPools.map(() => createRedis(inject('redisUrl'), logger));
});
afterAll(async () => {
  await Promise.all([pool, ...replicaPools].map((p) => p.end()));
  await Promise.all(replicaRedis.map((r) => r.quit()));
});

/** Resolves once `count` callers are waiting: makes requests arrive "at the same time". */
function createBarrier(count: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const everyone = new Promise<void>((resolve) => (release = resolve));
  return async () => {
    arrived += 1;
    if (arrived === count) release();
    await everyone;
  };
}

function errorCode(result: PromiseSettledResult<unknown>): string {
  if (result.status === 'fulfilled') return 'OK';
  return result.reason instanceof AppError ? result.reason.code : String(result.reason);
}

describe('the race this design prevents', () => {
  it('naive read-then-write tells every racer they got the same seat', async () => {
    const RACERS = 10;
    const { showId, seatIds } = await createShowFixture(pool, 1);
    const seat = seatIds[0]!;
    const users = await createUsers(pool, RACERS);
    const bookingIds = await Promise.all(
      users.map(async (userId) => {
        const { rows } = await pool.query<{ id: string }>(
          `INSERT INTO bookings (user_id, show_id, total_paise, expires_at)
           VALUES ($1, $2, 20000, now() + interval '5 minutes') RETURNING id`,
          [userId, showId],
        );
        return rows[0]!.id;
      }),
    );

    // Check, await, then write: the pattern that looks safe in single-threaded Node.
    const barrier = createBarrier(RACERS);
    const naiveHold = async (bookingId: string): Promise<boolean> => {
      const { rows } = await pool.query<{ status: string }>(
        'SELECT status FROM show_seats WHERE id = $1',
        [seat],
      );
      if (rows[0]!.status !== 'AVAILABLE') return false;
      await barrier(); // every racer has now read AVAILABLE
      await pool.query(
        `UPDATE show_seats SET status = 'HELD', booking_id = $2,
                held_until = now() + interval '5 minutes' WHERE id = $1`,
        [seat, bookingId],
      );
      return true;
    };

    const told = await Promise.all(bookingIds.map(naiveHold));

    // All ten buyers were told "the seat is yours"...
    expect(told.filter(Boolean)).toHaveLength(RACERS);
    // ...but only the last writer actually owns it. Nine double bookings.
    const { rows } = await pool.query<{ booking_id: string }>(
      'SELECT booking_id FROM show_seats WHERE id = $1',
      [seat],
    );
    expect(bookingIds).toContain(rows[0]!.booking_id);
  });
});

describe.each(HOLD_STRATEGIES)('holds under contention, %s strategy', (strategyName) => {
  let replicas: BookingService[];

  beforeAll(() => {
    replicas = replicaPools.map((p, i) =>
      createBookingService(
        p,
        { ...DEFAULT_BOOKING_CONFIG, strategy: strategyName },
        createStrategy(strategyName, { redis: replicaRedis[i]!, logger }),
      ),
    );
  });

  it('gives one seat to exactly one of 200 buyers spread over 3 replicas', async () => {
    const BUYERS = 200;
    const { showId, seatIds } = await createShowFixture(pool, 1);
    const users = await createUsers(pool, BUYERS);

    const results = await Promise.allSettled(
      users.map((userId, i) => replicas[i % 3]!.hold(userId, { showId, seatIds: [seatIds[0]!] })),
    );

    const codes = results.map(errorCode);
    expect(codes.filter((c) => c === 'OK')).toHaveLength(1);
    expect(codes.filter((c) => c === 'SEATS_UNAVAILABLE')).toHaveLength(BUYERS - 1);

    const winner = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{
      id: string;
    }>;
    const { rows } = await pool.query<{ booking_id: string; pending: number }>(
      `SELECT ss.booking_id,
              (SELECT count(*)::int FROM bookings WHERE show_id = $1 AND status = 'PENDING_PAYMENT') AS pending
       FROM show_seats ss WHERE ss.id = $2`,
      [showId, seatIds[0]],
    );
    expect(rows[0]).toEqual({ booking_id: winner.value.id, pending: 1 });
  });

  it('never splits a booking when overlapping multi-seat requests race', async () => {
    const BUYERS = 60;
    const SEATS = 10;
    const { showId, seatIds } = await createShowFixture(pool, SEATS);
    const users = await createUsers(pool, BUYERS);

    // Each buyer wants 3 neighbouring seats; the windows overlap heavily.
    const wanted = users.map((_, i) => {
      const start = i % (SEATS - 2);
      return seatIds.slice(start, start + 3);
    });

    const results = await Promise.allSettled(
      users.map((userId, i) => replicas[i % 3]!.hold(userId, { showId, seatIds: wanted[i]! })),
    );

    // Losers fail cleanly: no deadlocks, no unexpected errors.
    for (const code of results.map(errorCode)) {
      expect(['OK', 'SEATS_UNAVAILABLE']).toContain(code);
    }

    // All or nothing: every booking holds exactly the seats it recorded.
    const { rows } = await pool.query<{ recorded: number; held: number }>(
      `SELECT (SELECT count(*)::int FROM booking_seats bs WHERE bs.booking_id = b.id) AS recorded,
              (SELECT count(*)::int FROM show_seats ss
               WHERE ss.booking_id = b.id AND ss.status = 'HELD') AS held
       FROM bookings b WHERE b.show_id = $1`,
      [showId],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toEqual({ recorded: 3, held: 3 });
    }
  });

  it('lets one user win only one hold per show, even with simultaneous requests', async () => {
    const { showId, seatIds } = await createShowFixture(pool, 10);
    const [userId] = await createUsers(pool, 1);

    const results = await Promise.allSettled(
      seatIds.map((seatId, i) => replicas[i % 3]!.hold(userId!, { showId, seatIds: [seatId] })),
    );

    const codes = results.map(errorCode);
    expect(codes.filter((c) => c === 'OK')).toHaveLength(1);
    expect(codes.filter((c) => c === 'ACTIVE_HOLD_EXISTS')).toHaveLength(seatIds.length - 1);
  });
});
