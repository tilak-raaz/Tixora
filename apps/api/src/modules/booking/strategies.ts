import { randomUUID } from 'node:crypto';
import type { Logger, PoolClient, Redis } from '@bmt/platform';
import { withTimeout } from '../../lib/timeout';

/**
 * Three ways to take seats, behind one interface, so they can be tested and
 * benchmarked side by side (ADR 0005). In every strategy Postgres has the final
 * word: the seat row changes owner only inside the hold transaction.
 */
export const HOLD_STRATEGIES = ['conditional', 'pessimistic', 'redis'] as const;
export type HoldStrategyName = (typeof HOLD_STRATEGIES)[number];

export interface SeatRequest {
  showId: string;
  showSeatIds: string[];
}

export interface HoldRequest extends SeatRequest {
  bookingId: string;
  heldUntil: Date;
}

export type PreLockResult =
  { ok: true; release: () => Promise<void> } | { ok: false; takenSeatIds: string[] };

export interface SeatHoldStrategy {
  readonly name: HoldStrategyName;
  /**
   * Optional fast filter run before any database work. It may turn a request
   * away early, but it never decides who owns a seat.
   */
  preLock?(request: SeatRequest): Promise<PreLockResult>;
  /**
   * Runs inside the hold transaction. Holds the requested seats if all of them
   * are free and returns the ids taken. Returning fewer ids than requested
   * tells the caller to roll back.
   */
  takeSeats(tx: PoolClient, hold: HoldRequest): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// conditional: one statement (also the core under redis)
// ---------------------------------------------------------------------------

/**
 * Locks the requested rows in id order (so overlapping requests queue in the
 * same order and never deadlock), then updates only the rows still free.
 * Postgres re-checks the WHERE clause after each lock wait, so a request that
 * queued behind a winner sees the seat already HELD. One round trip.
 */
export const conditionalStrategy: SeatHoldStrategy = {
  name: 'conditional',
  async takeSeats(tx, hold) {
    const { rows } = await tx.query<{ id: string }>(
      `WITH requested AS (
         SELECT id FROM show_seats
         WHERE show_id = $2 AND id = ANY($3::uuid[])
         ORDER BY id
         FOR NO KEY UPDATE
       )
       UPDATE show_seats ss
       SET status = 'HELD', booking_id = $1, held_until = $4, version = ss.version + 1
       FROM requested
       WHERE ss.id = requested.id
         AND (ss.status = 'AVAILABLE' OR (ss.status = 'HELD' AND ss.held_until <= now()))
       RETURNING ss.id`,
      [hold.bookingId, hold.showId, hold.showSeatIds, hold.heldUntil],
    );
    return rows.map((r) => r.id);
  },
};

// ---------------------------------------------------------------------------
// pessimistic: lock, check in the application, then update
// ---------------------------------------------------------------------------

/**
 * The textbook version: SELECT ... FOR UPDATE, decide in application code while
 * holding the locks, then UPDATE. Correct, but the locks are held across an
 * extra network round trip, so contended seats stay locked longer.
 */
export const pessimisticStrategy: SeatHoldStrategy = {
  name: 'pessimistic',
  async takeSeats(tx, hold) {
    const { rows } = await tx.query<{ id: string; free: boolean }>(
      `SELECT id, (status = 'AVAILABLE' OR (status = 'HELD' AND held_until <= now())) AS free
       FROM show_seats
       WHERE show_id = $1 AND id = ANY($2::uuid[])
       ORDER BY id
       FOR UPDATE`,
      [hold.showId, hold.showSeatIds],
    );
    const free = rows.filter((r) => r.free).map((r) => r.id);
    if (free.length !== hold.showSeatIds.length) return free; // shortfall: caller rolls back

    await tx.query(
      `UPDATE show_seats
       SET status = 'HELD', booking_id = $1, held_until = $3, version = version + 1
       WHERE id = ANY($2::uuid[])`,
      [hold.bookingId, free, hold.heldUntil],
    );
    return free;
  },
};

// ---------------------------------------------------------------------------
// redis: a short Redis lock in front of the conditional update
// ---------------------------------------------------------------------------

/**
 * Takes every key or none, atomically. Returns 0 on success, or the 1-based
 * position of the first key that is already locked.
 */
const ACQUIRE = `
for i, key in ipairs(KEYS) do
  if redis.call('EXISTS', key) == 1 then return i end
end
for _, key in ipairs(KEYS) do
  redis.call('SET', key, ARGV[1], 'PX', ARGV[2])
end
return 0`;

/** Deletes only the keys this request still owns (its token), never someone else's. */
const RELEASE = `
local released = 0
for _, key in ipairs(KEYS) do
  if redis.call('GET', key) == ARGV[1] then
    redis.call('DEL', key)
    released = released + 1
  end
end
return released`;

export interface RedisStrategyStats {
  /** Requests turned away by Redis before they touched Postgres. */
  rejectedByRedis: number;
  /** Times Redis was unreachable and the request went straight to Postgres. */
  redisErrors: number;
}

/**
 * While one request is inside its hold transaction, every other request for
 * the same seats is refused by Redis in well under a millisecond, without a
 * Postgres connection or row lock. The lock lives only for the transaction
 * (a few ms; `lockTtlMs` is the safety net if the process dies). The 5-minute
 * hold itself lives in Postgres.
 *
 * Why Redis never decides: a Redis lock can vanish (failover, eviction, TTL
 * passing during a long GC pause), so two requests might both pass it. That is
 * fine because the conditional update behind it is still correct. And if Redis
 * is down, requests skip the filter and Postgres alone keeps holds correct.
 */
export function createRedisStrategy(
  redis: Redis,
  logger: Logger,
  options: { lockTtlMs?: number; timeoutMs?: number } = {},
): SeatHoldStrategy & { stats: RedisStrategyStats } {
  const lockTtlMs = options.lockTtlMs ?? 5_000;
  // How long a hold waits for Redis before going to Postgres alone. A live client queues commands
  // while Redis is away and retries them for seconds; the Redis failure drill (ADR 0017) saw holds
  // time out that way, although Postgres could have answered at once.
  const timeoutMs = options.timeoutMs ?? 200;
  const skip = () => {
    stats.redisErrors += 1;
    return { ok: true as const, release: async () => undefined };
  };
  const stats: RedisStrategyStats = { rejectedByRedis: 0, redisErrors: 0 };

  return {
    name: 'redis',
    stats,
    async preLock({ showId, showSeatIds }) {
      const seatIds = [...showSeatIds].sort();
      // The {showId} hash tag keeps one show's keys in one slot, so the
      // multi-key scripts also work on a Redis Cluster.
      const keys = seatIds.map((id) => `bmt:seat-lock:{${showId}}:${id}`);
      const token = randomUUID();

      // Not connected (down, or reconnecting): do not even queue the command.
      if (redis.status !== 'ready') return skip();
      let firstTaken: number;
      try {
        firstTaken = Number(
          await withTimeout(
            redis.eval(ACQUIRE, keys.length, ...keys, token, lockTtlMs),
            timeoutMs,
            'seat pre-lock',
          ),
        );
      } catch (err) {
        logger.warn({ err }, 'seat pre-lock unavailable; holding through Postgres alone');
        return skip();
      }

      if (firstTaken !== 0) {
        stats.rejectedByRedis += 1;
        return { ok: false, takenSeatIds: [seatIds[firstTaken - 1]!] };
      }
      return {
        ok: true,
        // Bounded too: if Redis has gone, the lock expires by itself after lockTtlMs.
        release: async () => {
          await withTimeout(
            redis.eval(RELEASE, keys.length, ...keys, token),
            timeoutMs,
            'seat pre-lock release',
          ).catch(() => undefined);
        },
      };
    },
    takeSeats: conditionalStrategy.takeSeats,
  };
}

export function createStrategy(
  name: HoldStrategyName,
  deps: { redis: Redis; logger: Logger },
): SeatHoldStrategy {
  switch (name) {
    case 'conditional':
      return conditionalStrategy;
    case 'pessimistic':
      return pessimisticStrategy;
    case 'redis':
      return createRedisStrategy(deps.redis, deps.logger);
  }
}
