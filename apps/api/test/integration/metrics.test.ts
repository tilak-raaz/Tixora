import { randomUUID } from 'node:crypto';
import { createEmailQueue, registerWorkerMetrics } from '@bmt/jobs';
import { createMetricsRegistry, writeOutbox } from '@bmt/platform';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../../src/app';
import { createApiMetrics } from '../../src/lib/metrics';
import { createShowFixture } from './fixtures';
import { createTestDeps } from './helpers';
import { signInAsUser, type Agent } from './sessions';

let deps: ReturnType<typeof createTestDeps>;

beforeAll(() => {
  deps = createTestDeps();
});
afterAll(async () => {
  await deps.close();
});

function hold(agent: Agent, showId: string, seatIds: string[]) {
  return agent
    .post('/api/v1/bookings')
    .set('Idempotency-Key', randomUUID())
    .send({ showId, seatIds });
}

/** The value of the one sample of `name` whose labels include all of `labels`. */
function sample(text: string, name: string, labels: string[] = []): number | undefined {
  const line = text
    .split('\n')
    .find((l) => l.startsWith(`${name}{`) && labels.every((label) => l.includes(label)));
  return line === undefined ? undefined : Number(line.split(' ').at(-1));
}

describe('API metrics', () => {
  it('count every hold attempt by how it ended', async () => {
    const metrics = createApiMetrics({ pool: deps.pool });
    const app = createApp({ ...deps, metrics });
    const { showId, seatIds } = await createShowFixture(deps.pool, 4);

    // Six buyers want the same seat at once: exactly one gets it, the Redis pre-lock or
    // Postgres turns the rest away.
    const buyers = await Promise.all(Array.from({ length: 6 }, () => signInAsUser(app)));
    const results = await Promise.all(buyers.map((b) => hold(b, showId, [seatIds[0]!])));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);

    // The winner asks again on the same show: refused, it already has a hold there.
    const winner = buyers[results.findIndex((r) => r.status === 201)]!;
    expect((await hold(winner, showId, [seatIds[1]!])).status).toBe(409);

    const text = (await request(app).get('/metrics').expect(200)).text;
    const outcome = (o: string) => sample(text, 'bmt_holds_total', [`outcome="${o}"`]) ?? 0;
    expect(outcome('held')).toBe(1);
    expect(outcome('rejected_early') + outcome('seats_taken')).toBe(5);
    expect(outcome('refused')).toBe(1);
    expect(outcome('error')).toBe(0);
    expect(
      sample(text, 'bmt_http_request_duration_seconds_count', [
        'route="/api/v1/bookings"',
        'status="201"',
      ]),
    ).toBe(1);
  });
});

describe('worker metrics', () => {
  it('read queue depth from Redis and outbox lag from Postgres when scraped', async () => {
    const registry = createMetricsRegistry({ service: 'worker' });
    const queue = createEmailQueue(inject('redisUrl'), { prefix: `bmt-test-${randomUUID()}` });
    registerWorkerMetrics({
      registry,
      pool: deps.pool,
      logger: deps.logger,
      workers: [],
      queues: [queue],
    });
    const aggregateId = randomUUID();
    try {
      await queue.add(
        'booking-confirmed',
        { outboxId: randomUUID(), bookingId: aggregateId, requestId: null },
        { delay: 60_000 },
      );
      await writeOutbox(
        deps.pool,
        'booking.confirmed',
        { bookingId: aggregateId },
        { aggregateId },
      );
      await deps.pool.query(
        "UPDATE outbox SET created_at = now() - interval '30 seconds' WHERE aggregate_id = $1",
        [aggregateId],
      );

      const text = await registry.metrics();
      expect(sample(text, 'bmt_queue_jobs', ['queue="email"', 'state="delayed"'])).toBe(1);
      expect(sample(text, 'bmt_queue_jobs', ['queue="email"', 'state="waiting"'])).toBe(0);
      expect(sample(text, 'bmt_outbox_unpublished')).toBeGreaterThanOrEqual(1);
      expect(sample(text, 'bmt_outbox_oldest_seconds')).toBeGreaterThanOrEqual(29);
    } finally {
      await deps.pool.query('DELETE FROM outbox WHERE aggregate_id = $1', [aggregateId]);
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});
