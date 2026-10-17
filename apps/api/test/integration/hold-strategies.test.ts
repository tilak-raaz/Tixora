import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { createLogger, createPool, createRedis, type Pool, type Redis } from '@bmt/platform';
import { Redis as IORedis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppError } from '../../src/lib/errors';
import { createBookingService, DEFAULT_BOOKING_CONFIG } from '../../src/modules/booking/service';
import { createRedisStrategy } from '../../src/modules/booking/strategies';
import { createShowFixture, createUsers } from './fixtures';

/** What the Redis strategy adds on top of Postgres, and what it must never take away. */

const logger = createLogger({ name: 'test', level: 'silent' });
const config = { ...DEFAULT_BOOKING_CONFIG, strategy: 'redis' as const };
let pool: Pool;
let redis: Redis;

beforeAll(() => {
  pool = createPool({
    connectionString: inject('databaseUrl'),
    max: 10,
    applicationName: 'bmt-test',
    logger,
  });
  redis = createRedis(inject('redisUrl'), logger);
});
afterAll(async () => {
  await pool.end();
  await redis.quit();
});

const lockKey = (showId: string, seatId: string) => `bmt:seat-lock:{${showId}}:${seatId}`;

function codeOf(err: unknown): string {
  return err instanceof AppError ? err.code : String(err);
}

describe('redis strategy', () => {
  it('releases its Redis locks once the hold is done, whether it succeeded or not', async () => {
    const strategy = createRedisStrategy(redis, logger);
    const bookings = createBookingService(pool, config, strategy);
    const { showId, seatIds } = await createShowFixture(pool, 2);
    const [alice, bob] = await createUsers(pool, 2);

    await bookings.hold(alice!, { showId, seatIds: [seatIds[0]!] });
    await expect(bookings.hold(bob!, { showId, seatIds })).rejects.toThrow(AppError);

    expect(await redis.exists(lockKey(showId, seatIds[0]!), lockKey(showId, seatIds[1]!))).toBe(0);
  });

  it('turns a request away early while another holds the Redis lock, taking no keys itself', async () => {
    const strategy = createRedisStrategy(redis, logger);
    const bookings = createBookingService(pool, config, strategy);
    const { showId, seatIds } = await createShowFixture(pool, 2);
    const [user] = await createUsers(pool, 1);
    // Another request is mid-transaction on seat 1.
    await redis.set(lockKey(showId, seatIds[1]!), 'someone-else', 'PX', 5_000);

    const err = await bookings.hold(user!, { showId, seatIds }).catch((e: unknown) => e);

    expect(codeOf(err)).toBe('SEATS_UNAVAILABLE');
    expect(strategy.stats.rejectedByRedis).toBe(1);
    // All or nothing in Redis too: seat 0 was not locked, and the other lock is untouched.
    expect(await redis.exists(lockKey(showId, seatIds[0]!))).toBe(0);
    expect(await redis.get(lockKey(showId, seatIds[1]!))).toBe('someone-else');
    const { rowCount } = await pool.query('SELECT 1 FROM bookings WHERE show_id = $1', [showId]);
    expect(rowCount).toBe(0);
  });

  it('still lets Postgres refuse a held seat when no Redis lock exists', async () => {
    // The Redis lock lives only for the transaction; the 5-minute hold is in Postgres.
    const bookings = createBookingService(pool, config, createRedisStrategy(redis, logger));
    const { showId, seatIds } = await createShowFixture(pool, 1);
    const [alice, bob] = await createUsers(pool, 2);
    await bookings.hold(alice!, { showId, seatIds });

    const err = await bookings.hold(bob!, { showId, seatIds }).catch((e: unknown) => e);

    expect(codeOf(err)).toBe('SEATS_UNAVAILABLE');
  });

  it('keeps holds correct when Redis is down, falling back to Postgres alone', async () => {
    const deadRedis = new IORedis({
      host: '127.0.0.1',
      port: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    const strategy = createRedisStrategy(deadRedis, logger);
    const bookings = createBookingService(pool, config, strategy);
    const { showId, seatIds } = await createShowFixture(pool, 1);
    const users = await createUsers(pool, 30);

    const results = await Promise.allSettled(
      users.map((userId) => bookings.hold(userId, { showId, seatIds })),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const codes = results.flatMap((r) => (r.status === 'rejected' ? [codeOf(r.reason)] : []));
    expect(new Set(codes)).toEqual(new Set(['SEATS_UNAVAILABLE']));
    expect(strategy.stats.redisErrors).toBe(30);
    deadRedis.disconnect();
  });

  it('does not make holds wait for a Redis that has gone away, the way a live client sees it', async () => {
    // A server that accepts connections and never answers, and a client set up as in production
    // (it queues commands and keeps retrying). Before the fix each hold waited seconds for it.
    // It reads and drops what it receives (a paused socket would never see the client hang up),
    // and its sockets are destroyed at the end so the server can close.
    const sockets = new Set<Socket>();
    const silent: Server = createServer((socket) => {
      sockets.add(socket);
      socket.resume();
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { port } = silent.address() as AddressInfo;
    const goneRedis = createRedis(`redis://127.0.0.1:${port}`, logger);
    try {
      const strategy = createRedisStrategy(goneRedis, logger);
      const bookings = createBookingService(pool, config, strategy);
      const { showId, seatIds } = await createShowFixture(pool, 1);
      const users = await createUsers(pool, 10);

      const started = Date.now();
      const results = await Promise.allSettled(
        users.map((userId) => bookings.hold(userId, { showId, seatIds })),
      );

      expect(Date.now() - started).toBeLessThan(2_000);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(strategy.stats.redisErrors).toBe(10);
    } finally {
      goneRedis.disconnect();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => silent.close(resolve));
    }
    // Without the fix the holds hang on the silent server; fail in 10 s, not the default 30.
  }, 10_000);
});
