import type { Pool, Redis } from '@bmt/platform';
import { Router } from 'express';

const CHECK_TIMEOUT_MS = 1_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms).unref();
    }),
  ]);
}

/**
 * /healthz: the process is up (liveness). Never touches dependencies, so a
 * database outage does not make the orchestrator restart healthy processes.
 *
 * /readyz: the process can serve traffic (readiness). nginx and deploy scripts
 * use it to stop routing to a replica that lost Postgres or Redis.
 */
export function healthRouter(deps: { pool: Pool; redis: Redis }): Router {
  const router = Router();

  router.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/readyz', async (_req, res) => {
    const [postgres, redis] = await Promise.allSettled([
      withTimeout(deps.pool.query('SELECT 1'), CHECK_TIMEOUT_MS),
      withTimeout(deps.redis.ping(), CHECK_TIMEOUT_MS),
    ]);
    const checks = {
      postgres: postgres.status === 'fulfilled' ? 'ok' : 'down',
      redis: redis.status === 'fulfilled' ? 'ok' : 'down',
    };
    const ready = checks.postgres === 'ok' && checks.redis === 'ok';
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
  });

  return router;
}
