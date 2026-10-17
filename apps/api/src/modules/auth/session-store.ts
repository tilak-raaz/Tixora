import { redisStorage } from '@better-auth/redis-storage';
import type { Logger, Redis } from '@bmt/platform';
import { withTimeout } from '../../lib/timeout';

/** Longest a request waits for Redis before using the session's copy in Postgres instead. */
const REDIS_WAIT_MS = 250;

/**
 * Better Auth's Redis session store, made to survive a Redis outage. The Redis failure drill
 * (ADR 0017) found that a Redis error made every signed-in request fail, although every session is
 * also stored in Postgres (storeSessionInDatabase) and Better Auth reads Postgres when Redis has no
 * copy. So:
 *
 * - **get**: Redis down, or slower than 250 ms, counts as "no copy", and the session comes from
 *   Postgres. Signed-in users stay signed in, one query slower.
 * - **set**: best effort. Postgres has the session; a missing copy only means a Postgres read.
 * - **delete** (sign-out, revoking a session) is left to fail while Redis is down. Better Auth
 *   deletes the Redis copy before the Postgres row, so the failure leaves the session whole rather
 *   than half deleted. Known limit: Better Auth still answers the sign-out with 200 and clears the
 *   cookie, so the user is signed out in the browser, but the session stays valid on the server
 *   until it expires; a copy of the cookie taken earlier would keep working. Closing that needs a
 *   revocation list checked on every request, which is not worth it for a Redis outage plus a
 *   stolen cookie (session-redis-down.test.ts pins the behaviour).
 */
export function createSessionStore(deps: { client: Redis; keyPrefix: string; logger: Logger }) {
  const redis = redisStorage({ client: deps.client, keyPrefix: deps.keyPrefix });
  const logger = deps.logger.child({ module: 'session-store' });
  const usable = () => deps.client.status === 'ready';

  return {
    ...redis,
    async get(key: string): Promise<string | null> {
      if (!usable()) return null;
      try {
        return await withTimeout(redis.get(key), REDIS_WAIT_MS, 'session read');
      } catch (err) {
        logger.warn({ err }, 'session cache unavailable; reading the session from Postgres');
        return null;
      }
    },
    async set(key: string, value: string, ttl?: number): Promise<void> {
      if (!usable()) return;
      try {
        await withTimeout(redis.set(key, value, ttl), REDIS_WAIT_MS, 'session write');
      } catch (err) {
        logger.warn({ err }, 'session cache not updated; Postgres has the session');
      }
    },
  };
}
