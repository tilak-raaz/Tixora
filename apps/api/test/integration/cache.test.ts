import { randomUUID } from 'node:crypto';
import { createLogger, createRedis } from '@bmt/platform';
import { Redis as IORedis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../../src/app';
import { createCache, type Cache } from '../../src/lib/cache';
import { createShowFixture } from './fixtures';
import { createTestDeps } from './helpers';
import { signInAsAdmin } from './sessions';

/** The catalog read cache: hits, version-based invalidation across replicas, one load per crowd, and Redis down. */

const logger = createLogger({ name: 'test', level: 'silent' });
let deps: ReturnType<typeof createTestDeps>;

beforeAll(() => {
  deps = createTestDeps();
});
afterAll(async () => {
  await deps.close();
});

/** A cache with its own prefix, so tests never see each other's entries. */
const freshCache = (prefix = `bmt-test:cache:${randomUUID()}`, ttlSeconds = 60) =>
  createCache(deps.redis, logger, { prefix, ttlSeconds });

const city = () => {
  const tag = randomUUID().slice(0, 8);
  return { name: `City ${tag}`, slug: `city-${tag}`, state: 'Odisha', timezone: 'Asia/Kolkata' };
};

describe('cache-aside', () => {
  it('serves the second read from Redis', async () => {
    const app = createApp({ ...deps, cache: freshCache() });

    const first = await request(app).get('/api/v1/cities');
    const second = await request(app).get('/api/v1/cities');

    expect(first.headers['x-cache']).toBe('MISS');
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.body).toEqual(first.body);
  });

  it('keeps different queries apart', async () => {
    const app = createApp({ ...deps, cache: freshCache() });
    const { showId } = await createShowFixture(deps.pool, 1);
    const { body } = await request(app).get(`/api/v1/shows/${showId}`);
    const movieId = body.show.movie.id as string;

    await request(app).get(`/api/v1/movies/${movieId}`);
    const other = await request(app).get(`/api/v1/shows/${showId}`);

    expect(other.headers['x-cache']).toBe('HIT');
    expect((await request(app).get(`/api/v1/movies/${movieId}`)).headers['x-cache']).toBe('HIT');
  });

  it('expires entries after the TTL', async () => {
    const app = createApp({ ...deps, cache: freshCache(undefined, 1) });
    await request(app).get('/api/v1/cities');

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect((await request(app).get('/api/v1/cities')).headers['x-cache']).toBe('MISS');
  });

  it('never caches the seat map', async () => {
    const app = createApp({ ...deps, cache: freshCache() });
    const { showId } = await createShowFixture(deps.pool, 1);

    await request(app).get(`/api/v1/shows/${showId}/seats`);
    const again = await request(app).get(`/api/v1/shows/${showId}/seats`);

    expect(again.headers['x-cache']).toBeUndefined();
  });

  it('does not cache a 404', async () => {
    const app = createApp({ ...deps, cache: freshCache() });
    const id = randomUUID();

    expect((await request(app).get(`/api/v1/movies/${id}`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/movies/${id}`)).status).toBe(404);
  });
});

describe('invalidation', () => {
  it('shows an admin write on every replica at once', async () => {
    const prefix = `bmt-test:cache:${randomUUID()}`;
    // Two replicas: separate Redis connections and caches, one shared prefix.
    const other = createTestDeps();
    const appA = createApp({ ...deps, cache: createCache(deps.redis, logger, { prefix }) });
    const appB = createApp({ ...other, cache: createCache(other.redis, logger, { prefix }) });

    try {
      await request(appB).get('/api/v1/cities');
      expect((await request(appB).get('/api/v1/cities')).headers['x-cache']).toBe('HIT');

      const admin = await signInAsAdmin(appA, deps);
      const added = city();
      expect((await admin.post('/api/v1/admin/cities').send(added)).status).toBe(201);

      const after = await request(appB).get('/api/v1/cities');
      expect(after.headers['x-cache']).toBe('MISS');
      expect(after.body.cities.map((c: { slug: string }) => c.slug)).toContain(added.slug);
    } finally {
      await other.close();
    }
  });

  it('leaves the cache alone when the write is refused', async () => {
    const cache = freshCache();
    const app = createApp({ ...deps, cache });
    await request(app).get('/api/v1/cities');
    const admin = await signInAsAdmin(app, deps);

    const res = await admin.post('/api/v1/admin/cities').send({ name: '' });

    expect(res.status).toBe(400);
    expect((await request(app).get('/api/v1/cities')).headers['x-cache']).toBe('HIT');
  });
});

describe('under load and failure', () => {
  it('loads once when twenty requests miss the same key at once', async () => {
    const cache: Cache = freshCache();
    let loads = 0;
    const load = async () => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { answer: 42 };
    };

    const results = await Promise.all(
      Array.from({ length: 20 }, () => cache.getOrLoad('catalog', 'popular', load)),
    );

    expect(loads).toBe(1);
    expect(results.every((r) => r.value.answer === 42)).toBe(true);
    expect((await cache.getOrLoad('catalog', 'popular', load)).outcome).toBe('HIT');
  });

  it('reads straight from Postgres when Redis is down', async () => {
    const dead = new IORedis({
      host: '127.0.0.1',
      port: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    const app = createApp({ ...deps, cache: createCache(dead, logger, { timeoutMs: 50 }) });

    const res = await request(app).get('/api/v1/cities');

    expect(res.status).toBe(200);
    expect(res.headers['x-cache']).toBe('BYPASS');
    dead.disconnect();
  });

  it('survives Redis answering slowly', async () => {
    const slow = createRedis(inject('redisUrl'), logger);
    const realGet = slow.get.bind(slow);
    // Every GET takes longer than the cache is willing to wait.
    slow.get = ((key: string) =>
      new Promise((resolve) => setTimeout(() => resolve(realGet(key)), 300))) as typeof slow.get;
    const app = createApp({ ...deps, cache: createCache(slow, logger, { timeoutMs: 50 }) });

    try {
      const started = Date.now();
      const res = await request(app).get('/api/v1/cities');
      expect(res.headers['x-cache']).toBe('BYPASS');
      expect(Date.now() - started).toBeLessThan(250);
    } finally {
      await slow.quit();
    }
  });
});
