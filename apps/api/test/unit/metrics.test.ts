import { EventEmitter } from 'node:events';
import { onJobFinished, type JobFinished } from '@bmt/jobs';
import {
  createLogger,
  createMetricsRegistry,
  startMetricsServer,
  type Pool,
  type Redis,
} from '@bmt/platform';
import { Redis as IORedis } from 'ioredis';
import pg from 'pg';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { createApiMetrics, routeLabel } from '../../src/lib/metrics';
import { createAuth } from '../../src/modules/auth/auth';

const silent = createLogger({ name: 'test', level: 'silent' });
const auth = createAuth({
  logger: silent,
  pool: new pg.Pool({ connectionString: 'postgres://unused@127.0.0.1:1/unused' }),
  redis: new IORedis({ lazyConnect: true }),
  config: { secret: 'a'.repeat(32), baseURL: 'http://localhost:4000', trustedOrigins: [] },
});

const fakePool = {
  query: async () => ({ rows: [] }),
  totalCount: 4,
  idleCount: 1,
  waitingCount: 2,
} as unknown as Pool;
const fakeRedis = { ping: async () => 'PONG' } as unknown as Redis;

/** The value of the one sample of `name` whose labels include all of `labels`. */
function valueOf(text: string, name: string, labels: string[] = []): number | undefined {
  const line = text
    .split('\n')
    .find((l) => l.startsWith(`${name}{`) && labels.every((label) => l.includes(label)));
  return line === undefined ? undefined : Number(line.split(' ').at(-1));
}

function appWithMetrics() {
  const metrics = createApiMetrics({
    pool: fakePool,
    seatStreams: () => ({ shows: 2, streams: 5 }),
    instance: 'api-test',
  });
  return createApp({ logger: silent, pool: fakePool, redis: fakeRedis, auth, metrics });
}

describe('routeLabel', () => {
  const label = (originalUrl: string, path?: unknown) =>
    routeLabel({ originalUrl, route: path === undefined ? undefined : { path } } as never);

  it('uses the route pattern, so every id shares one series', () => {
    expect(label('/api/v1/bookings/6a0058', '/bookings/:id')).toBe('/api/v1/bookings/:id');
    expect(label('/api/v1/shows/943c/seats?x=1', '/shows/:id/seats')).toBe(
      '/api/v1/shows/:id/seats',
    );
  });

  it('keeps nested mount points, which Express forgets once a handler throws', () => {
    expect(label('/api/v1/admin/cities/9', '/cities/:id')).toBe('/api/v1/admin/cities/:id');
    expect(label('/webhooks/razorpay/', '/webhooks/razorpay')).toBe('/webhooks/razorpay');
  });

  it('puts paths that matched no route in one series', () => {
    expect(label('/wp-admin/setup.php')).toBe('unmatched');
  });

  it('names only the auth endpoints the app uses', () => {
    expect(label('/api/auth/sign-in/email', '/api/auth/*splat')).toBe('/api/auth/sign-in/email');
    expect(label('/api/auth/anything-else', '/api/auth/*splat')).toBe('/api/auth/other');
  });
});

describe('GET /metrics on the API', () => {
  it('times requests by route and status, but not health checks or itself', async () => {
    const app = appWithMetrics();
    await request(app).get('/api/v1/does-not-exist').expect(404);
    await request(app).get('/healthz').expect(200);

    const res = await request(app).get('/metrics').expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(
      valueOf(res.text, 'bmt_http_request_duration_seconds_count', [
        'method="GET"',
        'route="unmatched"',
        'status="404"',
        'service="api"',
        'instance="api-test"',
      ]),
    ).toBe(1);
    expect(res.text).not.toMatch(/route="\/healthz"/);
    expect(res.text).not.toMatch(/route="\/metrics"/);
  });

  it('reports seat streams, the pool, every hold outcome and the process', async () => {
    const res = await request(appWithMetrics()).get('/metrics').expect(200);
    expect(valueOf(res.text, 'bmt_seat_streams')).toBe(5);
    expect(valueOf(res.text, 'bmt_seat_stream_shows')).toBe(2);
    expect(valueOf(res.text, 'bmt_db_pool_connections', ['state="busy"'])).toBe(3);
    expect(valueOf(res.text, 'bmt_db_pool_connections', ['state="idle"'])).toBe(1);
    expect(valueOf(res.text, 'bmt_db_pool_waiting_queries')).toBe(2);
    for (const outcome of ['held', 'rejected_early', 'seats_taken', 'refused', 'error']) {
      expect(valueOf(res.text, 'bmt_holds_total', [`outcome="${outcome}"`])).toBe(0);
    }
    expect(valueOf(res.text, 'nodejs_eventloop_lag_p99_seconds')).toBeGreaterThanOrEqual(0);
  });

  it('is absent when the app has no metrics', async () => {
    const app = createApp({ logger: silent, pool: fakePool, redis: fakeRedis, auth });
    await request(app).get('/metrics').expect(404);
  });
});

describe('onJobFinished', () => {
  it('reports each finished job with its queue, result and time taken', () => {
    const worker = Object.assign(new EventEmitter(), { name: 'email' });
    const seen: JobFinished[] = [];
    onJobFinished(worker as unknown as Parameters<typeof onJobFinished>[0], (e) => seen.push(e));

    worker.emit('completed', { processedOn: 1_000, finishedOn: 1_250 });
    worker.emit('failed', undefined, new Error('smtp down'));

    expect(seen).toEqual([
      { queue: 'email', result: 'completed', seconds: 0.25 },
      { queue: 'email', result: 'failed', seconds: undefined },
    ]);
  });
});

describe('startMetricsServer', () => {
  it('serves /metrics and /healthz, and nothing else', async () => {
    const registry = createMetricsRegistry({ service: 'worker', instance: 'worker-test' });
    const server = await startMetricsServer({ port: 0, registry, logger: silent });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);

      const metrics = await fetch(`${base}/metrics`);
      expect(metrics.status).toBe(200);
      expect(await metrics.text()).toMatch(/service="worker",instance="worker-test"/);

      expect((await fetch(`${base}/other`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
