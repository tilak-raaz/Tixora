import { createLogger, type Pool, type Redis } from '@bmt/platform';
import { Redis as IORedis } from 'ioredis';
import pg from 'pg';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { createAuth } from '../../src/modules/auth/auth';

// Better Auth gets clients pointing nowhere: nothing in these tests reaches
// /api/auth or /api/v1/me. Its start-up schema check fails quietly into the
// silent logger.
const silent = createLogger({ name: 'test', level: 'silent' });
const auth = createAuth({
  logger: silent,
  pool: new pg.Pool({ connectionString: 'postgres://unused@127.0.0.1:1/unused' }),
  redis: new IORedis({ lazyConnect: true }),
  config: { secret: 'a'.repeat(32), baseURL: 'http://localhost:4000', trustedOrigins: [] },
});

// Unit tests drive the real Express app with fake dependencies: no containers needed.
function appWith(overrides: { dbUp?: boolean; redisUp?: boolean } = {}) {
  const { dbUp = true, redisUp = true } = overrides;
  const pool = {
    query: async () => {
      if (!dbUp) throw new Error('connection refused');
      return { rows: [] };
    },
  } as unknown as Pool;
  const redis = {
    ping: async () => {
      if (!redisUp) throw new Error('connection refused');
      return 'PONG';
    },
  } as unknown as Redis;
  return createApp({ logger: silent, pool, redis, auth });
}

describe('error handling', () => {
  it('returns the standard 404 body for unknown routes', async () => {
    const res = await request(appWith()).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'No route for GET /api/v1/does-not-exist',
        requestId: expect.any(String),
      },
    });
  });

  it('returns 400 for malformed JSON instead of a 500', async () => {
    const res = await request(appWith())
      .post('/api/v1/anything')
      .set('content-type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('request IDs', () => {
  it('generates an ID and returns it in the header and the error body', async () => {
    const res = await request(appWith()).get('/nope');
    const id = res.headers['x-request-id'];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.error.requestId).toBe(id);
  });

  it('keeps a well-formed incoming ID', async () => {
    const res = await request(appWith()).get('/healthz').set('x-request-id', 'trace-1234abcd');
    expect(res.headers['x-request-id']).toBe('trace-1234abcd');
  });

  it('replaces a malformed incoming ID', async () => {
    const res = await request(appWith()).get('/healthz').set('x-request-id', 'bad id with spaces');
    expect(res.headers['x-request-id']).not.toBe('bad id with spaces');
  });
});

describe('readiness', () => {
  it('is ready when Postgres and Redis respond', async () => {
    const res = await request(appWith()).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready', checks: { postgres: 'ok', redis: 'ok' } });
  });

  it('reports 503 and names the dependency that is down', async () => {
    const res = await request(appWith({ dbUp: false })).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not_ready', checks: { postgres: 'down', redis: 'ok' } });
  });

  it('keeps liveness green even when dependencies are down', async () => {
    const res = await request(appWith({ dbUp: false, redisUp: false })).get('/healthz');
    expect(res.status).toBe(200);
  });
});
