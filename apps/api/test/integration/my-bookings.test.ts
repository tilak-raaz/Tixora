import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { createShowFixture } from './fixtures';
import { createTestDeps } from './helpers';
import { signInAsUser, type Agent } from './sessions';

/** GET /api/v1/bookings: the signed-in user's bookings, newest first. */

let deps: ReturnType<typeof createTestDeps>;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  deps = createTestDeps();
  app = createApp(deps);
});
afterAll(async () => {
  await deps.close();
});

async function hold(agent: Agent, seats: number): Promise<string> {
  const { showId, seatIds } = await createShowFixture(deps.pool, seats);
  const res = await agent
    .post('/api/v1/bookings')
    .set('Idempotency-Key', randomUUID())
    .send({ showId, seatIds });
  expect(res.status).toBe(201);
  return res.body.booking.id as string;
}

describe('my bookings', () => {
  it('requires a signed-in user', async () => {
    expect((await request(app).get('/api/v1/bookings')).status).toBe(401);
  });

  it("lists only the user's own bookings, newest first, with their show and seats", async () => {
    const me = await signInAsUser(app);
    const someoneElse = await signInAsUser(app);
    const first = await hold(me, 1);
    const second = await hold(me, 2);
    await hold(someoneElse, 1);

    const res = await me.get('/api/v1/bookings');
    expect(res.status).toBe(200);
    expect(res.body.bookings.map((b: { id: string }) => b.id)).toEqual([second, first]);

    const latest = res.body.bookings[0];
    expect(latest).toMatchObject({ status: 'PENDING_PAYMENT', totalPaise: 40_000 });
    expect(latest.seats).toEqual(['A1', 'A2']);
    expect(latest.show).toMatchObject({ screen: 'Audi 1', timezone: 'Asia/Kolkata' });
    expect(latest.show.movieTitle).toMatch(/^Movie /);
    expect(new Date(latest.show.startsAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('reports a hold whose time is up as EXPIRED before the sweeper gets to it', async () => {
    const me = await signInAsUser(app);
    const id = await hold(me, 1);
    await deps.pool.query(
      `UPDATE bookings SET created_at = now() - interval '10 minutes',
                           expires_at = now() - interval '1 minute' WHERE id = $1`,
      [id],
    );
    const res = await me.get('/api/v1/bookings');
    expect(res.body.bookings[0]).toMatchObject({ id, status: 'EXPIRED' });
  });
});
