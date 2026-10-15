import { randomUUID } from 'node:crypto';
import {
  createHoldExpiryQueue,
  createHoldExpiryScheduler,
  createHoldExpiryWorker,
  drainExpiredHolds,
  expireHold,
  startHoldSweeper,
} from '@bmt/jobs';
import { createLogger, createPool, type Pool } from '@bmt/platform';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { createBookingService, DEFAULT_BOOKING_CONFIG } from '../../src/modules/booking/service';
import { createShowFixture, createUsers } from './fixtures';
import { createTestDeps } from './helpers';
import { signInAsUser } from './sessions';

/** Hold expiry (ADR 0006): the delayed job, the sweeper, and how they fail. */

const logger = createLogger({ name: 'test', level: 'silent' });
// Queues in this file live under their own prefix, so they never see other jobs.
const prefix = `bmt-test-${randomUUID()}`;
let pool: Pool;

beforeAll(() => {
  pool = createPool({
    connectionString: inject('databaseUrl'),
    max: 10,
    applicationName: 'bmt-test',
    logger,
  });
});
afterAll(async () => {
  await pool.end();
});

async function hold(userId: string, showId: string, seatIds: string[]): Promise<string> {
  const booking = await createBookingService(pool).hold(userId, { showId, seatIds });
  return booking.id;
}

/** Moves holds into the past, as if 5 minutes had gone by. */
async function backdate(bookingIds: string[]): Promise<void> {
  await pool.query(
    `UPDATE bookings SET created_at = now() - interval '10 minutes',
                         expires_at = now() - interval '1 minute' WHERE id = ANY($1::uuid[])`,
    [bookingIds],
  );
  await pool.query(
    `UPDATE show_seats SET held_until = now() - interval '1 minute'
     WHERE booking_id = ANY($1::uuid[])`,
    [bookingIds],
  );
}

async function stateOf(bookingId: string) {
  const { rows } = await pool.query<{ status: string }>(
    'SELECT status FROM bookings WHERE id = $1',
    [bookingId],
  );
  const { rows: seats } = await pool.query<{ status: string; bookingId: string | null }>(
    `SELECT ss.status, ss.booking_id AS "bookingId"
     FROM booking_seats bs JOIN show_seats ss ON ss.id = bs.show_seat_id
     WHERE bs.booking_id = $1`,
    [bookingId],
  );
  return { status: rows[0]!.status, seats };
}

describe('expiring one hold (what the delayed job runs)', () => {
  it('expires a hold whose time is up and frees its seats', async () => {
    const { showId, seatIds } = await createShowFixture(pool, 2);
    const [user] = await createUsers(pool, 1);
    const id = await hold(user!, showId, seatIds);
    await backdate([id]);

    expect(await expireHold(pool, id)).toBe('expired');

    expect(await stateOf(id)).toEqual({
      status: 'EXPIRED',
      seats: [
        { status: 'AVAILABLE', bookingId: null },
        { status: 'AVAILABLE', bookingId: null },
      ],
    });
  });

  it('leaves a hold alone while it is still running', async () => {
    const { showId, seatIds } = await createShowFixture(pool, 1);
    const [user] = await createUsers(pool, 1);
    const id = await hold(user!, showId, seatIds);

    expect(await expireHold(pool, id)).toBe('skipped');
    expect(await stateOf(id)).toEqual({
      status: 'PENDING_PAYMENT',
      seats: [{ status: 'HELD', bookingId: id }],
    });
  });

  it('leaves paid and cancelled bookings alone, even when the job runs late', async () => {
    const { showId, seatIds } = await createShowFixture(pool, 2);
    const [payer, canceller] = await createUsers(pool, 2);
    const paid = await hold(payer!, showId, [seatIds[0]!]);
    const cancelled = await hold(canceller!, showId, [seatIds[1]!]);
    await createBookingService(pool).release(canceller!, cancelled);
    await backdate([paid, cancelled]);
    // What M3's payment confirmation will do.
    await pool.query(
      "UPDATE show_seats SET status = 'BOOKED', held_until = NULL WHERE booking_id = $1",
      [paid],
    );
    await pool.query(
      "UPDATE bookings SET status = 'CONFIRMED', confirmed_at = now() WHERE id = $1",
      [paid],
    );

    expect(await expireHold(pool, paid)).toBe('skipped');
    expect(await expireHold(pool, cancelled)).toBe('skipped');
    expect(await stateOf(paid)).toEqual({
      status: 'CONFIRMED',
      seats: [{ status: 'BOOKED', bookingId: paid }],
    });
    expect((await stateOf(cancelled)).status).toBe('CANCELLED');
  });

  it('is safe to run twice', async () => {
    const { showId, seatIds } = await createShowFixture(pool, 1);
    const [user] = await createUsers(pool, 1);
    const id = await hold(user!, showId, seatIds);
    await backdate([id]);

    expect(await expireHold(pool, id)).toBe('expired');
    expect(await expireHold(pool, id)).toBe('skipped');
  });

  it('never frees a seat that another buyer has held since', async () => {
    const { showId, seatIds } = await createShowFixture(pool, 1);
    const [alice, bob] = await createUsers(pool, 2);
    const alicesHold = await hold(alice!, showId, seatIds);
    await backdate([alicesHold]);
    // Alice's hold ran out, so Bob can take the seat before anything cleans up.
    const bobsHold = await hold(bob!, showId, seatIds);

    expect(await expireHold(pool, alicesHold)).toBe('expired');

    expect((await stateOf(alicesHold)).status).toBe('EXPIRED');
    expect(await stateOf(bobsHold)).toEqual({
      status: 'PENDING_PAYMENT',
      seats: [{ status: 'HELD', bookingId: bobsHold }],
    });
  });
});

describe('the sweeper', () => {
  it('releases every overdue hold, batch by batch, and nothing else', async () => {
    const { showId, seatIds } = await createShowFixture(pool, 4);
    const users = await createUsers(pool, 4);
    const ids = await Promise.all(users.map((u, i) => hold(u, showId, [seatIds[i]!])));
    const [running, ...overdue] = ids;
    await backdate(overdue);

    const released = await drainExpiredHolds(pool, 2);

    expect(released).toEqual(expect.arrayContaining(overdue));
    expect(released).not.toContain(running);
    for (const id of overdue) expect((await stateOf(id)).status).toBe('EXPIRED');
    expect((await stateOf(running!)).status).toBe('PENDING_PAYMENT');
  });

  it('never releases a hold twice when several workers sweep at once', async () => {
    const { showId, seatIds } = await createShowFixture(pool, 40);
    const users = await createUsers(pool, 40);
    const ids: string[] = [];
    for (const [i, user] of users.entries()) ids.push(await hold(user, showId, [seatIds[i]!]));
    await backdate(ids);
    // Four workers, each with its own connections.
    const workers = Array.from({ length: 4 }, () =>
      createPool({
        connectionString: inject('databaseUrl'),
        max: 2,
        applicationName: 'bmt-test',
        logger,
      }),
    );

    try {
      const results = await Promise.all(workers.map((p) => drainExpiredHolds(p, 5)));

      const ours = new Set(ids);
      const releasedOfOurs = results.flat().filter((id) => ours.has(id));
      // Each hold released exactly once: no duplicates, none missed.
      expect(releasedOfOurs).toHaveLength(40);
      expect(new Set(releasedOfOurs).size).toBe(40);
    } finally {
      await Promise.all(workers.map((p) => p.end()));
    }
  });

  it('sweeps as soon as it starts, then stops cleanly', async () => {
    const { showId, seatIds } = await createShowFixture(pool, 1);
    const [user] = await createUsers(pool, 1);
    const id = await hold(user!, showId, seatIds);
    await backdate([id]);

    const sweeper = startHoldSweeper({ pool, logger }, { intervalMs: 60_000, batchSize: 100 });
    try {
      await vi.waitFor(async () => expect((await stateOf(id)).status).toBe('EXPIRED'), {
        timeout: 5_000,
        interval: 50,
      });
    } finally {
      await sweeper.stop();
    }
  });
});

describe('the queue', () => {
  it('queues one job per hold, due when the hold runs out', async () => {
    const queue = createHoldExpiryQueue(inject('redisUrl'), { prefix });
    const scheduler = createHoldExpiryScheduler(queue, logger, { graceMs: 1_000 });
    const bookingId = randomUUID();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    try {
      await scheduler.schedule(bookingId, expiresAt);
      await scheduler.schedule(bookingId, expiresAt); // a retry adds nothing

      const job = await queue.getJob(bookingId);
      expect(job?.data).toEqual({ bookingId });
      expect(job!.delay).toBeGreaterThan(5 * 60 * 1000 - 5_000);
      expect(job!.delay).toBeLessThanOrEqual(5 * 60 * 1000 + 1_000);
      expect(await queue.getDelayedCount()).toBe(1);
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it('expires a hold end to end: API service, queue, worker, Postgres', async () => {
    const queue = createHoldExpiryQueue(inject('redisUrl'), { prefix: `${prefix}-e2e` });
    const worker = createHoldExpiryWorker(
      { redisUrl: inject('redisUrl'), pool, logger },
      { prefix: `${prefix}-e2e` },
    );
    const bookings = createBookingService(
      pool,
      { ...DEFAULT_BOOKING_CONFIG, holdTtlSeconds: 1 },
      undefined,
      createHoldExpiryScheduler(queue, logger, { graceMs: 200 }),
    );
    const { showId, seatIds } = await createShowFixture(pool, 1);
    const [user] = await createUsers(pool, 1);

    try {
      const { id } = await bookings.hold(user!, { showId, seatIds });

      await vi.waitFor(async () => expect((await stateOf(id)).status).toBe('EXPIRED'), {
        timeout: 10_000,
        interval: 100,
      });
      expect((await stateOf(id)).seats).toEqual([{ status: 'AVAILABLE', bookingId: null }]);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it('still holds the seats when Redis is down, and the sweeper releases them later', async () => {
    const deadQueue = createHoldExpiryQueue('redis://127.0.0.1:1', {
      prefix,
      connection: {
        host: '127.0.0.1',
        port: 1,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
      },
    });
    deadQueue.on('error', () => undefined);
    const bookings = createBookingService(
      pool,
      DEFAULT_BOOKING_CONFIG,
      undefined,
      createHoldExpiryScheduler(deadQueue, logger, { timeoutMs: 300 }),
    );
    const { showId, seatIds } = await createShowFixture(pool, 1);
    const [user] = await createUsers(pool, 1);

    try {
      const started = Date.now();
      const booking = await bookings.hold(user!, { showId, seatIds });

      expect(booking.status).toBe('PENDING_PAYMENT');
      expect(Date.now() - started).toBeLessThan(2_000);

      await backdate([booking.id]);
      expect(await drainExpiredHolds(pool, 100)).toContain(booking.id);
    } finally {
      await Promise.race([deadQueue.close(), new Promise((r) => setTimeout(r, 1_000))]);
    }
  });
});

describe('the API', () => {
  it('queues the expiry job when it holds seats', async () => {
    const deps = createTestDeps();
    const queue = createHoldExpiryQueue(inject('redisUrl'), { prefix: `${prefix}-api` });
    const app = createApp({ ...deps, holdExpiry: createHoldExpiryScheduler(queue, logger) });

    try {
      const agent = await signInAsUser(app);
      const { showId, seatIds } = await createShowFixture(deps.pool, 1);

      const res = await agent
        .post('/api/v1/bookings')
        .set('Idempotency-Key', randomUUID())
        .send({ showId, seatIds });

      expect(res.status).toBe(201);
      const job = await queue.getJob(res.body.booking.id);
      expect(job?.data).toEqual({ bookingId: res.body.booking.id });
      expect(job!.delay).toBeGreaterThan(4 * 60 * 1000);
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
      await deps.close();
    }
  });
});
