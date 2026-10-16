import { randomUUID } from 'node:crypto';
import { Redis as IORedis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import {
  createRateLimiter,
  DEFAULT_RATE_LIMITS,
  type RateLimiter,
  type RatePolicy,
} from '../../src/lib/rate-limit';
import { createShowFixture } from './fixtures';
import { createTestDeps, WEB_ORIGIN } from './helpers';
import { signInAsUser } from './sessions';

/** Signs a new user up on one app and returns the session cookie, usable on any replica. */
async function sessionCookie(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await request(app)
    .post('/api/auth/sign-up/email')
    .set('origin', WEB_ORIGIN)
    .send({
      name: 'User',
      email: `user-${randomUUID()}@example.com`,
      password: 'test-password-123',
    });
  const cookies = res.headers['set-cookie'] as unknown as string[];
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

/** The rate limiter against real Redis: its edges, the HTTP contract, failure modes, and replicas. */

let deps: ReturnType<typeof createTestDeps>;
let limiter: RateLimiter;

beforeAll(() => {
  deps = createTestDeps();
  // A prefix per run, so keys never collide with other runs or files.
  limiter = createRateLimiter(deps.redis, { prefix: `bmt-test:rl:${randomUUID()}` });
});
afterAll(async () => {
  await deps.close();
});

const bucket = (limit: number, windowMs: number): RatePolicy => ({
  name: `bucket-${randomUUID()}`,
  algorithm: 'token-bucket',
  limit,
  windowMs,
  failMode: 'open',
});
const windowed = (limit: number, windowMs: number): RatePolicy => ({
  name: `window-${randomUUID()}`,
  algorithm: 'sliding-window',
  limit,
  windowMs,
  failMode: 'closed',
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('token bucket', () => {
  it('allows a full burst, then refuses with how long to wait', async () => {
    const policy = bucket(3, 60_000);
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await limiter.check(policy, 'u1'));

    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    // One token comes back every 20 s (3 per minute).
    expect(results[3]!.retryAfterMs).toBeGreaterThan(19_000);
    expect(results[3]!.retryAfterMs).toBeLessThanOrEqual(20_000);
  });

  it('refills over time, one token per window/limit', async () => {
    const policy = bucket(2, 400); // a token every 200 ms
    await limiter.check(policy, 'u1');
    await limiter.check(policy, 'u1');
    expect((await limiter.check(policy, 'u1')).allowed).toBe(false);

    await sleep(250);

    expect((await limiter.check(policy, 'u1')).allowed).toBe(true);
    expect((await limiter.check(policy, 'u1')).allowed).toBe(false);
  });

  it('keeps a separate budget per subject', async () => {
    const policy = bucket(1, 60_000);
    expect((await limiter.check(policy, 'alice')).allowed).toBe(true);
    expect((await limiter.check(policy, 'bob')).allowed).toBe(true);
    expect((await limiter.check(policy, 'alice')).allowed).toBe(false);
  });

  it('never lets more than the capacity through when requests arrive at once', async () => {
    const policy = bucket(10, 60_000);
    const results = await Promise.all(
      Array.from({ length: 50 }, () => limiter.check(policy, 'u1')),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });
});

describe('sliding window', () => {
  it('allows exactly `limit` in any window, and frees a slot as the oldest ages out', async () => {
    const policy = windowed(3, 300);
    const first = [];
    for (let i = 0; i < 4; i++) first.push((await limiter.check(policy, 'ip1')).allowed);
    expect(first).toEqual([true, true, true, false]);

    await sleep(320);

    expect((await limiter.check(policy, 'ip1')).allowed).toBe(true);
  });

  it('does not count refused attempts against the window', async () => {
    const policy = windowed(1, 300);
    await limiter.check(policy, 'ip1');
    for (let i = 0; i < 5; i++) await limiter.check(policy, 'ip1'); // all refused
    await sleep(320);
    expect((await limiter.check(policy, 'ip1')).allowed).toBe(true);
  });
});

describe('over HTTP', () => {
  it('answers 429 with Retry-After and RateLimit headers once a user uses up their holds', async () => {
    const policies = {
      ...DEFAULT_RATE_LIMITS,
      hold: { ...DEFAULT_RATE_LIMITS.hold, name: `hold-${randomUUID()}`, limit: 2 },
    };
    const app = createApp({ ...deps, rateLimits: { policies, limiter } });
    const agent = await signInAsUser(app);
    const { showId, seatIds } = await createShowFixture(deps.pool, 1);
    const hold = () =>
      agent.post('/api/v1/bookings').set('Idempotency-Key', randomUUID()).send({ showId, seatIds });

    const ok = await hold();
    expect(ok.headers['ratelimit-limit']).toBe('2');
    expect(ok.headers['ratelimit-remaining']).toBe('1');
    await hold();
    const refused = await hold();

    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('RATE_LIMITED');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('limits sign-in attempts per IP, not per account', async () => {
    const policies = {
      ...DEFAULT_RATE_LIMITS,
      auth: { ...DEFAULT_RATE_LIMITS.auth, name: `auth-${randomUUID()}`, limit: 3 },
    };
    const app = createApp({ ...deps, rateLimits: { policies, limiter } });
    const attempt = (ip: string) =>
      request(app)
        .post('/api/auth/sign-in/email')
        .set('origin', WEB_ORIGIN)
        .set('X-Forwarded-For', ip)
        .send({ email: `nobody-${randomUUID()}@example.com`, password: 'wrong-password' });

    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await attempt('203.0.113.7')).status);

    expect(statuses.slice(0, 3)).not.toContain(429);
    expect(statuses[3]).toBe(429);
    expect((await attempt('203.0.113.8')).status).not.toBe(429); // another IP has its own budget
  });

  it('never limits webhooks', async () => {
    const policies = {
      ...DEFAULT_RATE_LIMITS,
      browse: { ...DEFAULT_RATE_LIMITS.browse, name: `browse-${randomUUID()}`, limit: 1 },
    };
    const app = createApp({ ...deps, rateLimits: { policies, limiter } });
    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/webhooks/razorpay').send('{}');
      expect(res.status).not.toBe(429);
    }
  });
});

describe('when Redis is down', () => {
  const deadLimiter = () =>
    createRateLimiter(
      new IORedis({
        host: '127.0.0.1',
        port: 1,
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
      }),
      { timeoutMs: 100 },
    );

  it('lets browsing through (fail open)', async () => {
    const app = createApp({
      ...deps,
      rateLimits: { policies: DEFAULT_RATE_LIMITS, limiter: deadLimiter() },
    });
    const res = await request(app).get('/api/v1/cities');
    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-limit']).toBeUndefined();
  });

  it('refuses sign-in with 503 rather than allow unlimited guessing (fail closed)', async () => {
    const app = createApp({
      ...deps,
      rateLimits: { policies: DEFAULT_RATE_LIMITS, limiter: deadLimiter() },
    });
    const res = await request(app)
      .post('/api/auth/sign-in/email')
      .set('origin', WEB_ORIGIN)
      .send({ email: 'a@example.com', password: 'whatever-password' });
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
  });
});

describe('across replicas', () => {
  it('enforces one per-user budget across three API replicas, not three', async () => {
    const replicas = Array.from({ length: 3 }, () => createTestDeps());
    const policies = {
      ...DEFAULT_RATE_LIMITS,
      hold: { ...DEFAULT_RATE_LIMITS.hold, name: `hold-${randomUUID()}`, limit: 10 },
    };
    const prefix = `bmt-test:rl:${randomUUID()}`;
    // Each replica has its own Redis connection and its own limiter, as in production.
    const apps = replicas.map((r) =>
      createApp({
        ...r,
        rateLimits: { policies, limiter: createRateLimiter(r.redis, { prefix }) },
      }),
    );

    try {
      // One user, signed in once; the session works on every replica.
      const cookie = await sessionCookie(apps[0]!);
      const { showId, seatIds } = await createShowFixture(deps.pool, 1);

      const results = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          request(apps[i % 3]!)
            .post('/api/v1/bookings')
            .set('Cookie', cookie)
            .set('Idempotency-Key', randomUUID())
            .send({ showId, seatIds }),
        ),
      );

      const limited = results.filter((r) => r.status === 429).length;
      expect(results.length - limited).toBe(10);
      expect(limited).toBe(20);
    } finally {
      await Promise.all(replicas.map((r) => r.close()));
    }
  });
});
