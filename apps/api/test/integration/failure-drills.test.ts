import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createEmailQueue,
  createEmailWorker,
  drainOutbox,
  listFailed,
  openQueue,
  replayFailed,
  type JobSink,
} from '@bmt/jobs';
import { createFakeGateway } from '@bmt/payments';
import { createLogger, createRedis, type Redis } from '@bmt/platform';
import { Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { createTestDeps } from './helpers';
import { createCheckout } from './payment-fixtures';
import { createRedisMailer, delivered } from './support/redis-mailer';
import { deliver, paymentEvent, WEBHOOK_SECRET } from './webhooks';

/**
 * Failure drills (M4 exit criteria): a worker killed with SIGKILL in the
 * middle of a batch loses no email and sends none twice; and jobs that failed
 * for good can be replayed once the cause is fixed.
 */

const logger = createLogger({ name: 'test', level: 'silent' });
let deps: ReturnType<typeof createTestDeps>;
let app: ReturnType<typeof createApp>;
let redis: Redis;

beforeAll(() => {
  deps = createTestDeps();
  app = createApp({
    ...deps,
    paymentGateway: createFakeGateway(),
    paymentWebhookSecret: WEBHOOK_SECRET,
  });
  redis = createRedis(inject('redisUrl'), logger);
});
afterAll(async () => {
  await redis.quit();
  await deps.close();
});

/** Confirms `count` bookings and returns the outbox ids of their confirmation events. */
async function confirmBookings(count: number): Promise<string[]> {
  const bookingIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const c = await createCheckout(app, deps.pool, 1);
    await deliver(
      app,
      paymentEvent('payment.captured', { orderId: c.orderId, amountPaise: c.amountPaise }),
    );
    bookingIds.push(c.bookingId);
  }
  const { rows } = await deps.pool.query<{ id: string }>(
    "SELECT id FROM outbox WHERE topic = 'booking.confirmed' AND aggregate_id = ANY($1::uuid[])",
    [bookingIds],
  );
  return rows.map((r) => r.id);
}

function startWorkerProcess(env: Record<string, string>): Promise<ChildProcess> {
  const script = fileURLToPath(new URL('./support/email-worker-process.ts', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', script], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    child.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('ready')) resolve(child);
    });
    child.on('exit', (code) => reject(new Error(`worker process exited early (${code})`)));
  });
}

describe('a worker killed mid-batch', () => {
  it('loses no email and sends none twice', { timeout: 90_000 }, async () => {
    const prefix = `bmt-drill-${randomUUID()}`;
    const ns = `drill:${randomUUID()}`;
    const queue = createEmailQueue(inject('redisUrl'), { prefix });
    const mailer = createRedisMailer(redis, ns, 150);
    const ours = await confirmBookings(20);
    // Only this drill's events go into its queue: anything other test files left
    // unpublished is marked published first.
    await deps.pool.query(
      'UPDATE outbox SET published_at = now() WHERE published_at IS NULL AND NOT (id = ANY($1::uuid[]))',
      [ours],
    );
    const noRefunds: JobSink = { add: async () => undefined };
    await drainOutbox(deps.pool, { email: queue, refunds: noRefunds });
    const sentOfOurs = async () => (await delivered(redis, ns)).filter((k) => ours.includes(k));

    // 1. A worker in its own process starts on the batch...
    const child = await startWorkerProcess({
      DATABASE_URL: inject('databaseUrl'),
      REDIS_URL: inject('redisUrl'),
      QUEUE_PREFIX: prefix,
      MAIL_NS: ns,
      MAIL_DELAY_MS: '150',
    });
    // 2. ...and is killed without warning once a few emails are out, with more in flight.
    await vi.waitFor(async () => expect((await sentOfOurs()).length).toBeGreaterThanOrEqual(3), {
      timeout: 20_000,
      interval: 20,
    });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    const beforeKill = (await sentOfOurs()).length;
    expect(beforeKill).toBeLessThan(ours.length);

    // 3. A new worker takes over, including the jobs the dead one was holding.
    const worker = createEmailWorker(
      { redisUrl: inject('redisUrl'), pool: deps.pool, mailer, logger },
      { prefix, concurrency: 4, lockDuration: 1_500, stalledInterval: 500 },
    );
    const recorded = async () => {
      const { rows } = await deps.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM processed_messages
         WHERE consumer = 'email' AND message_id = ANY($1::uuid[])`,
        [ours],
      );
      return rows[0]!.n;
    };
    try {
      // Done means delivered and recorded: a job records its message only after
      // the provider has answered, so wait for both.
      await vi.waitFor(
        async () => {
          expect(new Set(await sentOfOurs()).size).toBe(ours.length);
          expect(await recorded()).toBe(ours.length);
        },
        { timeout: 60_000, interval: 200 },
      );

      // Every booking's email reached the buyer exactly once.
      const sent = await sentOfOurs();
      expect(sent).toHaveLength(ours.length);
      expect(new Set(sent)).toEqual(new Set(ours));
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});

describe('the dead letter queue', () => {
  it('keeps jobs that failed for good, lists why, and replays them once the cause is fixed', async () => {
    const prefix = `bmt-dlq-${randomUUID()}`;
    const queue = openQueue('email', inject('redisUrl'), { prefix });
    let broken = true;
    const done: string[] = [];
    const worker = new Worker(
      'email',
      async (job) => {
        if (broken) throw new Error('provider rejected the sender address');
        done.push(String(job.id));
      },
      { connection: { url: inject('redisUrl') }, prefix },
    );

    try {
      await queue.add('booking-confirmed', { outboxId: 'x' }, { jobId: 'job-1', attempts: 2 });
      await vi.waitFor(async () => expect(await queue.getFailedCount()).toBe(1), {
        timeout: 10_000,
        interval: 50,
      });

      expect(await listFailed(queue)).toMatchObject([
        { id: 'job-1', attemptsMade: 2, failedReason: 'provider rejected the sender address' },
      ]);

      broken = false; // the fix
      expect(await replayFailed(queue)).toEqual(['job-1']);

      await vi.waitFor(() => expect(done).toEqual(['job-1']), { timeout: 10_000, interval: 50 });
      expect(await queue.getFailedCount()).toBe(0);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});
