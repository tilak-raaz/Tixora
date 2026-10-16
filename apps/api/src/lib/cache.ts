import type { Logger, Redis } from '@bmt/platform';

/**
 * Cache-aside in Redis for read-mostly data (the catalog), shared by every
 * replica.
 *
 * - Keys carry a version per namespace: bmt:cache:catalog:v7:cities. An admin
 *   write increments the version (one INCR), so every replica's next read
 *   misses and loads fresh data. No key has to be found and deleted; old
 *   versions expire on their own.
 * - Concurrent misses for the same key in one process share one load, so a
 *   popular page expiring does not send a crowd of identical queries to Postgres.
 * - Redis being slow or down only costs speed: reads go straight to Postgres.
 *
 * Values are stored as JSON and come back as JSON (dates as strings), so cache
 * only what is about to be sent as a JSON response.
 */

export type CacheOutcome = 'HIT' | 'MISS' | 'BYPASS';

export interface Cache {
  getOrLoad<T>(
    namespace: string,
    key: string,
    load: () => Promise<T>,
  ): Promise<{ value: T; outcome: CacheOutcome }>;
  /** Makes every entry in the namespace stale, on every replica. */
  invalidate(namespace: string): Promise<void>;
}

export function createCache(
  redis: Redis,
  logger: Logger,
  opts: { prefix?: string; ttlSeconds?: number; timeoutMs?: number } = {},
): Cache {
  const prefix = opts.prefix ?? 'bmt:cache';
  const ttlSeconds = opts.ttlSeconds ?? 60;
  const timeoutMs = opts.timeoutMs ?? 100;
  const inFlight = new Map<string, Promise<unknown>>();

  const versionKey = (namespace: string) => `${prefix}:${namespace}:version`;

  return {
    async getOrLoad<T>(namespace: string, key: string, load: () => Promise<T>) {
      let fullKey: string;
      let cached: string | null;
      try {
        const version = (await withTimeout(redis.get(versionKey(namespace)), timeoutMs)) ?? '0';
        fullKey = `${prefix}:${namespace}:v${version}:${key}`;
        cached = await withTimeout(redis.get(fullKey), timeoutMs);
      } catch (err) {
        logger.debug({ err, namespace, key }, 'cache unavailable; reading from the database');
        return { value: await load(), outcome: 'BYPASS' as const };
      }
      if (cached !== null) return { value: JSON.parse(cached) as T, outcome: 'HIT' as const };

      // One load per key per process, however many requests missed together.
      let pending = inFlight.get(fullKey) as Promise<T> | undefined;
      if (!pending) {
        pending = (async () => {
          try {
            const value = await load();
            // A write that lands after an invalidation goes under the old
            // version, which nobody reads any more: it cannot resurrect stale data.
            await withTimeout(
              redis.set(fullKey, JSON.stringify(value), 'EX', ttlSeconds),
              timeoutMs,
            ).catch((err: unknown) => logger.debug({ err, fullKey }, 'cache write failed'));
            return value;
          } finally {
            inFlight.delete(fullKey);
          }
        })();
        inFlight.set(fullKey, pending);
      }
      return { value: await pending, outcome: 'MISS' as const };
    },

    async invalidate(namespace) {
      try {
        await withTimeout(redis.incr(versionKey(namespace)), timeoutMs);
      } catch (err) {
        // Entries then live out their TTL: stale for at most ttlSeconds.
        logger.warn({ err, namespace }, 'cache invalidation failed; entries expire within the TTL');
      }
    },
  };
}

/** For tests and for running without a cache: always loads. */
export const NO_CACHE: Cache = {
  async getOrLoad(_namespace, _key, load) {
    return { value: await load(), outcome: 'BYPASS' };
  },
  async invalidate() {},
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
