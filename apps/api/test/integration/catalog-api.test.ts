import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { CLEANING_BUFFER_MIN } from '../../src/modules/catalog/service';
import { createTestDeps } from './helpers';
import { signInAsAdmin, signInAsUser, type Agent } from './sessions';

/** YYYY-MM-DD in India, `daysAhead` days from now. */
function istDate(daysAhead: number): string {
  const when = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(when);
}

const DAY = istDate(3);
const OTHER_DAY = istDate(4);
const at = (time: string, day = DAY) => `${day}T${time}:00+05:30`;
const minutesBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 60_000;

let deps: ReturnType<typeof createTestDeps>;
let app: ReturnType<typeof createApp>;
let admin: Agent;

beforeAll(async () => {
  deps = createTestDeps();
  app = createApp(deps);
  admin = await signInAsAdmin(app, deps);
});
afterAll(async () => {
  await deps.close();
});

/**
 * Builds a small catalog through the admin API: a city with one theatre, a
 * 7-seat screen (row A: 4 Prime seats with an aisle after seat 2; row B: 3
 * Classic seats) and a 120-minute movie. Every call makes a fresh world.
 */
async function world() {
  const tag = randomUUID().slice(0, 8);
  const post = async (path: string, body: object) => {
    const res = await admin.post(`/api/v1/admin${path}`).send(body);
    if (res.status !== 201) throw new Error(`${path}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };

  const citySlug = `city-${tag}`;
  const theatreName = `Theatre ${tag}`;
  const { city } = await post('/cities', { name: `City ${tag}`, slug: citySlug, state: 'Odisha' });
  const { seatCategory: prime } = await post('/seat-categories', { name: `Prime ${tag}` });
  const { seatCategory: classic } = await post('/seat-categories', { name: `Classic ${tag}` });
  const { theatre } = await post('/theatres', {
    cityId: city.id,
    name: theatreName,
    address: 'Main Road',
  });
  const { screen } = await post('/screens', {
    theatreId: theatre.id,
    name: 'Audi 1',
    rows: [
      { label: 'A', categoryId: prime.id, seats: 4, aisleAfter: [2] },
      { label: 'B', categoryId: classic.id, seats: 3 },
    ],
  });
  const { movie } = await post('/movies', {
    title: `Movie ${tag}`,
    language: 'Hindi',
    durationMin: 120,
    releaseDate: '2026-06-01',
  });
  const prices = [
    { categoryId: prime.id, pricePaise: 28_000 },
    { categoryId: classic.id, pricePaise: 22_000 },
  ];
  const createShow = (startsAt: string) =>
    admin
      .post('/api/v1/admin/shows')
      .send({ movieId: movie.id, screenId: screen.id, startsAt, prices });

  return {
    city,
    citySlug,
    prime,
    classic,
    theatre,
    theatreName,
    screen,
    movie,
    prices,
    createShow,
  };
}

describe('admin access', () => {
  it('rejects anonymous requests with 401', async () => {
    const res = await request(app)
      .post('/api/v1/admin/cities')
      .send({ name: 'X', slug: 'x', state: 'Y' });
    expect(res.status).toBe(401);
  });

  it('rejects normal users with 403', async () => {
    const user = await signInAsUser(app);
    const res = await user.post('/api/v1/admin/cities').send({ name: 'X', slug: 'x', state: 'Y' });
    expect(res.status).toBe(403);
  });
});

describe('admin: building the catalog', () => {
  it('creates a screen with all its seats', async () => {
    const { screen } = await world();
    expect(screen.seatCount).toBe(7);
  });

  it('creates a show with one inventory row per seat, ending after duration + cleaning', async () => {
    const w = await world();
    const res = await w.createShow(at('10:00'));

    expect(res.status).toBe(201);
    expect(res.body.show.seatCount).toBe(7);
    expect(minutesBetween(res.body.show.startsAt, res.body.show.endsAt)).toBe(
      120 + CLEANING_BUFFER_MIN,
    );
  });

  it('rejects an overlapping show on the same screen with 409', async () => {
    const w = await world();
    await w.createShow(at('10:00'));

    const res = await w.createShow(at('11:30'));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'CONFLICT',
      message: 'This screen already has a show at that time',
    });
  });

  it('allows a show to start the moment the previous one ends', async () => {
    const w = await world();
    const first = await w.createShow(at('10:00'));
    const res = await w.createShow(first.body.show.endsAt);
    expect(res.status).toBe(201);
  });

  it('rejects a show missing a price for one of the screen’s categories', async () => {
    const w = await world();
    const res = await admin.post('/api/v1/admin/shows').send({
      movieId: w.movie.id,
      screenId: w.screen.id,
      startsAt: at('10:00'),
      prices: [w.prices[0]],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.missingCategoryIds).toEqual([w.classic.id]);
  });

  it('rejects a show in the past', async () => {
    const w = await world();
    const res = await w.createShow('2020-01-01T10:00:00+05:30');
    expect(res.status).toBe(400);
  });

  it('rejects a duplicate theatre name in the same city with 409', async () => {
    const w = await world();
    const res = await admin
      .post('/api/v1/admin/theatres')
      .send({ cityId: w.city.id, name: w.theatreName, address: 'Another Road' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('rejects a theatre in a city that does not exist with 400', async () => {
    const res = await admin
      .post('/api/v1/admin/theatres')
      .send({ cityId: randomUUID(), name: 'Nowhere', address: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('City not found');
  });

  it('rejects invalid input with one entry per problem', async () => {
    const res = await admin
      .post('/api/v1/admin/movies')
      .send({ title: '', language: 'Hindi', durationMin: 0, releaseDate: 'soon' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['title', 'durationMin', 'releaseDate']));
  });
});

describe('browsing', () => {
  let w: Awaited<ReturnType<typeof world>>;
  let showId: string;

  beforeAll(async () => {
    w = await world();
    const res = await w.createShow(at('18:00'));
    showId = res.body.show.id;
  });

  it('lists cities', async () => {
    const res = await request(app).get('/api/v1/cities');
    expect(res.status).toBe(200);
    expect(res.body.cities.map((c: { slug: string }) => c.slug)).toContain(w.citySlug);
  });

  it('lists movies playing in a city on a date, and none on another date', async () => {
    const slug = w.citySlug;

    const onDay = await request(app).get(`/api/v1/cities/${slug}/movies?date=${DAY}`);
    expect(onDay.status).toBe(200);
    expect(onDay.body.movies).toHaveLength(1);
    expect(onDay.body.movies[0]).toMatchObject({ id: w.movie.id, releaseDate: '2026-06-01' });

    const offDay = await request(app).get(`/api/v1/cities/${slug}/movies?date=${OTHER_DAY}`);
    expect(offDay.body.movies).toEqual([]);
  });

  it('returns 404 for an unknown city', async () => {
    const res = await request(app).get('/api/v1/cities/no-such-city/movies');
    expect(res.status).toBe(404);
  });

  it("lists a movie's shows grouped by theatre with free-seat counts", async () => {
    const slug = w.citySlug;
    const res = await request(app).get(
      `/api/v1/movies/${w.movie.id}/shows?city=${slug}&date=${DAY}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.theatres).toHaveLength(1);
    expect(res.body.theatres[0]).toMatchObject({
      id: w.theatre.id,
      shows: [{ id: showId, screen: 'Audi 1', availableSeats: 7 }],
    });
  });

  it('returns a show with its prices', async () => {
    const res = await request(app).get(`/api/v1/shows/${showId}`);
    expect(res.status).toBe(200);
    expect(res.body.show.prices).toHaveLength(2);
    expect(res.body.show.movie.id).toBe(w.movie.id);
  });

  it('returns the seat map laid out on the grid, aisle included', async () => {
    const res = await request(app).get(`/api/v1/shows/${showId}/seats`);

    expect(res.status).toBe(200);
    expect(res.body.seats).toHaveLength(7);
    const rowA = res.body.seats.filter((s: { row: string }) => s.row === 'A');
    expect(rowA.map((s: { x: number }) => s.x)).toEqual([0, 1, 3, 4]);
    expect(rowA[0]).toMatchObject({ number: 1, y: 0, pricePaise: 28_000, status: 'AVAILABLE' });
  });

  it('shows booked and actively held seats as UNAVAILABLE, expired holds as AVAILABLE', async () => {
    const ids = await deps.pool.query<{ id: string }>(
      'SELECT id FROM show_seats WHERE show_id = $1 ORDER BY id LIMIT 3',
      [showId],
    );
    const [booked, held, expired] = ids.rows.map((r) => r.id);
    await deps.pool.query("UPDATE show_seats SET status = 'BOOKED' WHERE id = $1", [booked]);
    await deps.pool.query(
      "UPDATE show_seats SET status = 'HELD', held_until = now() + interval '10 minutes' WHERE id = $1",
      [held],
    );
    await deps.pool.query(
      "UPDATE show_seats SET status = 'HELD', held_until = now() - interval '1 minute' WHERE id = $1",
      [expired],
    );

    const res = await request(app).get(`/api/v1/shows/${showId}/seats`);
    const status = (id: string | undefined) =>
      res.body.seats.find((s: { id: string }) => s.id === id)?.status;

    expect(status(booked)).toBe('UNAVAILABLE');
    expect(status(held)).toBe('UNAVAILABLE');
    expect(status(expired)).toBe('AVAILABLE');

    const slug = w.citySlug;
    const shows = await request(app).get(
      `/api/v1/movies/${w.movie.id}/shows?city=${slug}&date=${DAY}`,
    );
    expect(shows.body.theatres[0].shows[0].availableSeats).toBe(5);
  });

  it('answers 400 for a malformed id and 404 for an unknown one', async () => {
    expect((await request(app).get('/api/v1/shows/not-a-uuid')).status).toBe(400);
    expect((await request(app).get(`/api/v1/shows/${randomUUID()}`)).status).toBe(404);
  });
});
