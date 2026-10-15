import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { createShowFixture } from './fixtures';
import { createTestDeps } from './helpers';
import { signInAsUser, type Agent } from './sessions';

let deps: ReturnType<typeof createTestDeps>;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  deps = createTestDeps();
  app = createApp(deps);
});
afterAll(async () => {
  await deps.close();
});

function hold(agent: Agent, body: object, key: string = randomUUID()) {
  return agent.post('/api/v1/bookings').set('Idempotency-Key', key).send(body);
}

async function seatStatuses(showId: string): Promise<Record<string, string>> {
  const res = await request(app).get(`/api/v1/shows/${showId}/seats`);
  return Object.fromEntries(
    res.body.seats.map((s: { id: string; status: string }) => [s.id, s.status]),
  );
}

/** Moves a booking's hold into the past, as if 5 minutes had gone by. */
async function expire(bookingId: string): Promise<void> {
  await deps.pool.query(
    `UPDATE bookings SET created_at = now() - interval '10 minutes',
                         expires_at = now() - interval '1 minute' WHERE id = $1`,
    [bookingId],
  );
  await deps.pool.query(
    "UPDATE show_seats SET held_until = now() - interval '1 minute' WHERE booking_id = $1",
    [bookingId],
  );
}

describe('holding seats', () => {
  it('requires a signed-in user', async () => {
    const res = await request(app)
      .post('/api/v1/bookings')
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(res.status).toBe(401);
  });

  it('requires an Idempotency-Key header', async () => {
    const user = await signInAsUser(app);
    const { showId, seatIds } = await createShowFixture(deps.pool, 2);
    const res = await user.post('/api/v1/bookings').send({ showId, seatIds });
    expect(res.status).toBe(400);
  });

  it('holds the seats for 5 minutes and prices the booking', async () => {
    const user = await signInAsUser(app);
    const { showId, seatIds } = await createShowFixture(deps.pool, 4);
    const before = Date.now();

    const res = await hold(user, { showId, seatIds: seatIds.slice(0, 2) });

    expect(res.status).toBe(201);
    expect(res.body.booking).toMatchObject({
      showId,
      status: 'PENDING_PAYMENT',
      totalPaise: 40_000,
    });
    expect(res.body.booking.seats).toHaveLength(2);
    const holdMs = Date.parse(res.body.booking.expiresAt) - before;
    expect(holdMs).toBeGreaterThan(290_000);
    expect(holdMs).toBeLessThan(310_000);

    const statuses = await seatStatuses(showId);
    expect(statuses[seatIds[0]!]).toBe('UNAVAILABLE');
    expect(statuses[seatIds[1]!]).toBe('UNAVAILABLE');
    expect(statuses[seatIds[2]!]).toBe('AVAILABLE');
  });

  it('rejects more than 5 seats, repeated seats and seats from another show', async () => {
    const user = await signInAsUser(app);
    const { showId, seatIds } = await createShowFixture(deps.pool, 6);
    const other = await createShowFixture(deps.pool, 1);

    expect((await hold(user, { showId, seatIds })).status).toBe(400);
    expect((await hold(user, { showId, seatIds: [seatIds[0], seatIds[0]] })).status).toBe(400);

    const foreign = await hold(user, { showId, seatIds: [seatIds[0], other.seatIds[0]] });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.details.unknownSeatIds).toEqual([other.seatIds[0]]);
  });

  it('refuses a seat someone else holds, naming the seat', async () => {
    const alice = await signInAsUser(app);
    const bob = await signInAsUser(app);
    const { showId, seatIds } = await createShowFixture(deps.pool, 3);
    await hold(alice, { showId, seatIds: [seatIds[1]] });

    const res = await hold(bob, { showId, seatIds: [seatIds[0], seatIds[1]] });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SEATS_UNAVAILABLE');
    expect(res.body.error.details.unavailableSeatIds).toEqual([seatIds[1]]);
    // All or nothing: Bob did not get seat 0 either.
    expect((await seatStatuses(showId))[seatIds[0]!]).toBe('AVAILABLE');
  });

  it('allows one active hold per user per show', async () => {
    const user = await signInAsUser(app);
    const { showId, seatIds } = await createShowFixture(deps.pool, 2);
    await hold(user, { showId, seatIds: [seatIds[0]] });

    const res = await hold(user, { showId, seatIds: [seatIds[1]] });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ACTIVE_HOLD_EXISTS');
  });
});

describe('idempotency', () => {
  it('replays the first response for a retried request instead of booking twice', async () => {
    const user = await signInAsUser(app);
    const { showId, seatIds } = await createShowFixture(deps.pool, 2);
    const key = randomUUID();

    const first = await hold(user, { showId, seatIds }, key);
    const retry = await hold(user, { showId, seatIds: [...seatIds].reverse() }, key);

    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.booking.id).toBe(first.body.booking.id);
    const { rows } = await deps.pool.query('SELECT 1 FROM bookings WHERE show_id = $1', [showId]);
    expect(rows).toHaveLength(1);
  });

  it('rejects the same key reused for a different request', async () => {
    const user = await signInAsUser(app);
    const { showId, seatIds } = await createShowFixture(deps.pool, 2);
    const key = randomUUID();
    await hold(user, { showId, seatIds: [seatIds[0]] }, key);

    const res = await hold(user, { showId, seatIds: [seatIds[1]] }, key);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('lets a failed request be retried with the same key', async () => {
    const alice = await signInAsUser(app);
    const bob = await signInAsUser(app);
    const { showId, seatIds } = await createShowFixture(deps.pool, 1);
    const aliceHold = await hold(alice, { showId, seatIds });
    const key = randomUUID();

    expect((await hold(bob, { showId, seatIds }, key)).status).toBe(409);
    await alice.delete(`/api/v1/bookings/${aliceHold.body.booking.id}/hold`);
    const retry = await hold(bob, { showId, seatIds }, key);

    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
  });
});

describe('viewing and releasing a hold', () => {
  it('shows a booking to its owner only', async () => {
    const alice = await signInAsUser(app);
    const bob = await signInAsUser(app);
    const { showId, seatIds } = await createShowFixture(deps.pool, 1);
    const { body } = await hold(alice, { showId, seatIds });

    expect((await alice.get(`/api/v1/bookings/${body.booking.id}`)).status).toBe(200);
    expect((await bob.get(`/api/v1/bookings/${body.booking.id}`)).status).toBe(404);
  });

  it('releases the seats and cancels the booking, once', async () => {
    const user = await signInAsUser(app);
    const { showId, seatIds } = await createShowFixture(deps.pool, 2);
    const { body } = await hold(user, { showId, seatIds });

    const release = await user.delete(`/api/v1/bookings/${body.booking.id}/hold`);
    expect(release.status).toBe(200);
    expect(release.body.booking.status).toBe('CANCELLED');
    expect(Object.values(await seatStatuses(showId))).toEqual(['AVAILABLE', 'AVAILABLE']);

    const again = await user.delete(`/api/v1/bookings/${body.booking.id}/hold`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('HOLD_NOT_ACTIVE');
  });
});

describe('expired holds', () => {
  it('report EXPIRED, and stop blocking both the owner and other buyers', async () => {
    const alice = await signInAsUser(app);
    const bob = await signInAsUser(app);
    const { showId, seatIds } = await createShowFixture(deps.pool, 2);
    const { body } = await hold(alice, { showId, seatIds });
    await expire(body.booking.id);

    const view = await alice.get(`/api/v1/bookings/${body.booking.id}`);
    expect(view.body.booking.status).toBe('EXPIRED');

    // Bob can take one of Alice's expired seats; Alice can hold the other again.
    expect((await hold(bob, { showId, seatIds: [seatIds[0]] })).status).toBe(201);
    expect((await hold(alice, { showId, seatIds: [seatIds[1]] })).status).toBe(201);
  });
});
