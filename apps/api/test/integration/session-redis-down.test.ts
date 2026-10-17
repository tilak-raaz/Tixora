import { randomUUID } from 'node:crypto';
import type { Redis } from '@bmt/platform';
import { Redis as IORedis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { createAuth } from '../../src/modules/auth/auth';
import { createTestDeps, TEST_AUTH_CONFIG, WEB_ORIGIN } from './helpers';

/**
 * Found by the Redis failure drill (ADR 0017): with Redis down, every signed-in request failed with
 * "Failed to get session", although every session is also in Postgres. Two replicas share one
 * Postgres here; the second one's Redis is unreachable.
 */

let deps: ReturnType<typeof createTestDeps>;
let deadRedis: Redis;
let healthy: ReturnType<typeof createApp>;
let withoutRedis: ReturnType<typeof createApp>;

beforeAll(() => {
  deps = createTestDeps();
  healthy = createApp(deps);
  // Never connects: every command would fail, as during the drill.
  deadRedis = new IORedis({ port: 1, lazyConnect: true, maxRetriesPerRequest: 0 }) as Redis;
  const auth = createAuth({
    pool: deps.pool,
    redis: deadRedis,
    logger: deps.logger,
    config: TEST_AUTH_CONFIG,
  });
  withoutRedis = createApp({ ...deps, redis: deadRedis, auth });
});
afterAll(async () => {
  deadRedis.disconnect();
  await deps.close();
});

async function signUp(): Promise<{ cookie: string; email: string }> {
  const email = `redis-down-${randomUUID()}@example.com`;
  const res = await request(healthy)
    .post('/api/auth/sign-up/email')
    .set('origin', WEB_ORIGIN)
    .send({ name: 'Buyer', email, password: 'test-password-123' });
  expect(res.status).toBe(200);
  const cookies = res.headers['set-cookie'] as unknown as string[];
  return { cookie: cookies.map((c) => c.split(';')[0]).join('; '), email };
}

describe('sessions while Redis is down', () => {
  it('are read from Postgres, so signed-in users stay signed in', async () => {
    const { cookie, email } = await signUp();
    const res = await request(withoutRedis).get('/api/v1/me').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
  });

  it('still reject a request without a valid session', async () => {
    const res = await request(withoutRedis)
      .get('/api/v1/me')
      .set('Cookie', 'bmt.session_token=not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('signing out clears the cookie, but the session stays valid until Redis is back', async () => {
    // A known limit, recorded here so a change in Better Auth shows up: sign-out deletes the Redis
    // copy first, that fails, so the Postgres row is not deleted either. Better Auth still answers
    // 200 and clears the cookie, so the user is signed out in their browser; a copy of the cookie
    // taken earlier would keep working until the session expires.
    const { cookie } = await signUp();
    const res = await request(withoutRedis)
      .post('/api/auth/sign-out')
      .set('origin', WEB_ORIGIN)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const cleared = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('bmt.session_token='),
    );
    expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);

    // Nothing was half deleted: the session is whole, in Redis and in Postgres.
    const me = await request(healthy).get('/api/v1/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
  });
});
