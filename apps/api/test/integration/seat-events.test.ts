import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { startHoldSweeper } from '@bmt/jobs';
import { createRedis, createSeatEventPublisher, seatEventChannel } from '@bmt/platform';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../../src/app';
import { createBookingService } from '../../src/modules/booking/service';
import { createSeatEventHub, type SeatEventHub } from '../../src/modules/live/hub';
import { createShowFixture, createUsers } from './fixtures';
import { createTestDeps } from './helpers';
import { signInAsUser, type Agent } from './sessions';
import { openSse, seatsIn, type SseConnection } from './sse';

/**
 * Live seat maps (ADR 0013), across two replicas: what one replica or the worker changes reaches
 * a browser connected to the other, the heartbeat exposes events that never arrived, and a dropped
 * subscription asks browsers to resync.
 */

const HEARTBEAT_MS = 300;

interface Replica {
  deps: ReturnType<typeof createTestDeps>;
  hub: SeatEventHub;
  app: ReturnType<typeof createApp>;
  server: Server;
  url: string;
}

async function startReplica(opts: { streamsPerIp?: number } = {}): Promise<Replica> {
  const deps = createTestDeps();
  const hub = createSeatEventHub(deps, { heartbeatMs: HEARTBEAT_MS });
  const app = createApp({
    ...deps,
    seatEvents: createSeatEventPublisher(deps),
    seatEventHub: hub,
    seatStreamsPerIp: opts.streamsPerIp ?? 50,
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { deps, hub, app, server, url: `http://127.0.0.1:${port}` };
}

async function stopReplica(replica: Replica): Promise<void> {
  const closed = new Promise((resolve) => replica.server.close(resolve));
  await replica.hub.close();
  await closed;
  await replica.deps.close();
}

let a: Replica;
let b: Replica;
const open: SseConnection[] = [];

beforeAll(async () => {
  [a, b] = await Promise.all([startReplica(), startReplica()]);
});
afterAll(async () => {
  for (const stream of open) stream.close();
  await Promise.all([stopReplica(a), stopReplica(b)]);
});

/** A viewer of the show on a replica, once the stream says it is ready. */
async function watch(replica: Replica, showId: string): Promise<SseConnection> {
  const stream = await openSse(`${replica.url}/api/v1/shows/${showId}/seats/events`);
  open.push(stream);
  expect(stream.status).toBe(200);
  await stream.waitFor((e) => e.event === 'ready');
  return stream;
}

async function hold(agent: Agent, showId: string, seatIds: string[]): Promise<string> {
  const res = await agent
    .post('/api/v1/bookings')
    .set('Idempotency-Key', randomUUID())
    .send({ showId, seatIds });
  expect(res.status).toBe(201);
  return res.body.booking.id as string;
}

/** A `seats` event in which every one of these seats has this status. */
const seatsAre = (seatIds: string[], status: string) => (e: { event: string; data: string }) => {
  if (e.event !== 'seats') return false;
  const seats = seatsIn(e);
  return seatIds.every((id) => seats.get(id)?.status === status);
};

describe('seat events across replicas', () => {
  it('a hold on replica B reaches a viewer on replica A within a second', async () => {
    const { showId, seatIds } = await createShowFixture(a.deps.pool, 6);
    const viewer = await watch(a, showId);
    const buyer = await signInAsUser(b.app);

    const started = Date.now();
    await hold(buyer, showId, [seatIds[0]!, seatIds[1]!]);
    const event = await viewer.waitFor(seatsAre([seatIds[0]!, seatIds[1]!], 'UNAVAILABLE'), 1_000);

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(JSON.parse(event.data).showId).toBe(showId);
    viewer.close();
  });

  it('a release follows with a higher version, so it cannot be mistaken for older news', async () => {
    const { showId, seatIds } = await createShowFixture(a.deps.pool, 4);
    const viewer = await watch(a, showId);
    const buyer = await signInAsUser(b.app);

    const bookingId = await hold(buyer, showId, [seatIds[2]!]);
    const held = await viewer.waitFor(seatsAre([seatIds[2]!], 'UNAVAILABLE'));
    expect((await buyer.delete(`/api/v1/bookings/${bookingId}/hold`)).status).toBe(200);
    const released = await viewer.waitFor(seatsAre([seatIds[2]!], 'AVAILABLE'));

    expect(seatsIn(released).get(seatIds[2]!)!.version).toBeGreaterThan(
      seatsIn(held).get(seatIds[2]!)!.version,
    );
    viewer.close();
  });

  it('a hold released by the worker reaches viewers on every replica', async () => {
    const { showId, seatIds } = await createShowFixture(a.deps.pool, 4);
    const [onA, onB] = await Promise.all([watch(a, showId), watch(b, showId)]);
    const bookingId = await hold(await signInAsUser(a.app), showId, [seatIds[0]!]);

    // Five minutes later, as far as the database is concerned.
    await a.deps.pool.query(
      `UPDATE bookings SET created_at = now() - interval '10 minutes',
                           expires_at = now() - interval '1 minute' WHERE id = $1`,
      [bookingId],
    );
    await a.deps.pool.query(
      `UPDATE show_seats SET held_until = now() - interval '1 minute' WHERE booking_id = $1`,
      [bookingId],
    );

    // The worker: its own connections, its own publisher. The sweeper runs once at start-up.
    const worker = createTestDeps();
    const sweeper = startHoldSweeper(
      { pool: worker.pool, logger: worker.logger, seatEvents: createSeatEventPublisher(worker) },
      { intervalMs: 60_000, batchSize: 500 },
    );
    try {
      await Promise.all([
        onA.waitFor(seatsAre([seatIds[0]!], 'AVAILABLE')),
        onB.waitFor(seatsAre([seatIds[0]!], 'AVAILABLE')),
      ]);
    } finally {
      await sweeper.stop();
      await worker.close();
      onA.close();
      onB.close();
    }
  });
});

describe('the heartbeat', () => {
  it("carries the show's seat version, which moves even when an event is lost", async () => {
    const { showId, seatIds } = await createShowFixture(a.deps.pool, 3);
    const viewer = await watch(a, showId);
    const first = await viewer.waitFor((e) => e.event === 'heartbeat');
    const before = JSON.parse(first.data).seatsVersion as number;
    expect(typeof before).toBe('number');

    // A change that commits but is never announced, as if the process died before publishing.
    await a.deps.pool.query('UPDATE show_seats SET version = version + 1 WHERE id = $1', [
      seatIds[0],
    ]);
    const later = await viewer.waitFor(
      (e) => e.event === 'heartbeat' && JSON.parse(e.data).seatsVersion === before + 1,
    );
    expect(later).toBeDefined();
    // No `seats` event arrived for it: only the version gives it away.
    expect(viewer.events.some((e) => e.event === 'seats')).toBe(false);
    viewer.close();
  });
});

describe('subscriptions', () => {
  it('subscribes once per show and unsubscribes when the last viewer leaves', async () => {
    const { showId } = await createShowFixture(a.deps.pool, 2);
    const channel = seatEventChannel(showId);
    const subscribers = async () =>
      ((await a.deps.redis.call('PUBSUB', 'NUMSUB', channel)) as [string, number])[1];

    const first = await watch(a, showId);
    const second = await watch(a, showId);
    expect(await subscribers()).toBe(1);
    expect(a.hub.stats().streams).toBeGreaterThanOrEqual(2);

    first.close();
    second.close();
    await expect.poll(subscribers, { timeout: 2_000 }).toBe(0);
  });

  it('asks viewers to resync when the subscription drops, then keeps delivering', async () => {
    const { showId, seatIds } = await createShowFixture(a.deps.pool, 3);
    const viewer = await watch(a, showId);

    // Drop every subscriber connection, as a Redis failover would; ioredis reconnects.
    const admin = createRedis(inject('redisUrl'), a.deps.logger);
    await admin.call('CLIENT', 'KILL', 'TYPE', 'pubsub');
    await admin.quit();

    await viewer.waitFor((e) => e.event === 'resync', 5_000);
    // B's hub was dropped too and comes back on its own; A still delivers after its resync.
    await expect
      .poll(
        async () =>
          (
            (await a.deps.redis.call('PUBSUB', 'NUMSUB', seatEventChannel(showId))) as [
              string,
              number,
            ]
          )[1],
        { timeout: 5_000 },
      )
      .toBe(1);
    await hold(await signInAsUser(b.app), showId, [seatIds[1]!]);
    await viewer.waitFor(seatsAre([seatIds[1]!], 'UNAVAILABLE'));
    viewer.close();
  });
});

describe('the endpoint', () => {
  it('sends the headers that keep proxies from buffering', async () => {
    const { showId } = await createShowFixture(a.deps.pool, 1);
    const viewer = await watch(a, showId);
    expect(viewer.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(viewer.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(viewer.headers.get('x-accel-buffering')).toBe('no');
    viewer.close();
  });

  it('answers 404 for an unknown show', async () => {
    const res = await request(a.app).get(`/api/v1/shows/${randomUUID()}/seats/events`);
    expect(res.status).toBe(404);
  });

  it('limits how many live maps one address keeps open on a replica', async () => {
    const limited = await startReplica({ streamsPerIp: 2 });
    try {
      const { showId } = await createShowFixture(limited.deps.pool, 1);
      const url = `${limited.url}/api/v1/shows/${showId}/seats/events`;
      const first = await openSse(url);
      const second = await openSse(url);
      const third = await openSse(url);
      expect([first.status, second.status, third.status]).toEqual([200, 200, 429]);

      // Closing one frees its place.
      first.close();
      await expect
        .poll(async () => {
          const again = await openSse(url);
          again.close();
          return again.status;
        })
        .toBe(200);
      second.close();
    } finally {
      await stopReplica(limited);
    }
  });

  it('answers 503 when live updates are not configured', async () => {
    const deps = createTestDeps();
    try {
      const { showId } = await createShowFixture(deps.pool, 1);
      const res = await request(createApp(deps)).get(`/api/v1/shows/${showId}/seats/events`);
      expect(res.status).toBe(503);
    } finally {
      await deps.close();
    }
  });
});

describe('the publisher', () => {
  it('sends the state the database holds after the change', async () => {
    const { showId, seatIds } = await createShowFixture(a.deps.pool, 2);
    const viewer = await watch(a, showId);
    const [userId] = await createUsers(a.deps.pool, 1);
    // A hold made without announcing it, then announced afterwards: what goes out is read back.
    const booking = await createBookingService(a.deps.pool).hold(userId!, {
      showId,
      seatIds: [seatIds[0]!],
    });
    await createSeatEventPublisher(a.deps).publishBookings([booking.id]);

    const event = await viewer.waitFor(seatsAre([seatIds[0]!], 'UNAVAILABLE'));
    const { rows } = await a.deps.pool.query<{ version: number }>(
      'SELECT version FROM show_seats WHERE id = $1',
      [seatIds[0]],
    );
    expect(seatsIn(event).get(seatIds[0]!)!.version).toBe(rows[0]!.version);
    viewer.close();
  });

  it('never throws when Redis is unreachable: the change has already committed', async () => {
    const { showId, seatIds } = await createShowFixture(a.deps.pool, 1);
    const [userId] = await createUsers(a.deps.pool, 1);
    const booking = await createBookingService(a.deps.pool).hold(userId!, {
      showId,
      seatIds: [seatIds[0]!],
    });
    const broken = createRedis('redis://127.0.0.1:1', a.deps.logger);
    broken.on('error', () => undefined);
    try {
      const publisher = createSeatEventPublisher(
        { pool: a.deps.pool, redis: broken, logger: a.deps.logger },
        { timeoutMs: 200 },
      );
      const started = Date.now();
      await expect(publisher.publishBookings([booking.id])).resolves.toBeUndefined();
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      broken.disconnect();
    }
  });
});
