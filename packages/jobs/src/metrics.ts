import { Counter, Gauge, Histogram, type Logger, type Pool, type Registry } from '@bmt/platform';
import type { Job, Worker } from 'bullmq';

/**
 * The worker's own metrics (ADR 0015), on top of the process and pool ones from
 * createMetricsRegistry. Job counts and durations are this worker's; queue depth and outbox lag
 * are read from Redis and Postgres at scrape time, so they are the same on every worker.
 */

/**
 * Any of our BullMQ workers, whatever its job data and job names. BullMQ's own default
 * (`Worker`) fixes the job name to `string`, which a worker with named jobs is not assignable to.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyWorker = Worker<any, any, any>;

export type JobResult = 'completed' | 'failed';

export interface JobFinished {
  queue: string;
  /** `failed` counts every failed attempt, including the ones BullMQ will retry. */
  result: JobResult;
  /** From when this worker picked the job up until it finished; undefined if BullMQ has no times. */
  seconds: number | undefined;
}

/** Calls `listener` each time `worker` finishes a job, whichever way it ended. */
export function onJobFinished(worker: AnyWorker, listener: (event: JobFinished) => void): void {
  const seconds = (job: Job | undefined) =>
    job?.processedOn && job.finishedOn ? (job.finishedOn - job.processedOn) / 1000 : undefined;
  worker.on('completed', (job) => {
    listener({ queue: worker.name, result: 'completed', seconds: seconds(job) });
  });
  worker.on('failed', (job) => {
    listener({ queue: worker.name, result: 'failed', seconds: seconds(job) });
  });
}

/** What the queue-depth gauge needs from a BullMQ queue. */
export interface CountableQueue {
  readonly name: string;
  getJobCounts(...types: ('waiting' | 'active' | 'delayed' | 'failed')[]): Promise<{
    [state: string]: number;
  }>;
}

const QUEUE_STATES = ['waiting', 'active', 'delayed', 'failed'] as const;

export function registerWorkerMetrics(deps: {
  registry: Registry;
  pool: Pool;
  logger: Logger;
  workers: AnyWorker[];
  queues: CountableQueue[];
}): void {
  const { registry, pool, logger } = deps;

  const jobs = new Counter({
    name: 'bmt_jobs_total',
    help: 'Jobs this worker finished, by queue and result (failed counts every failed attempt)',
    labelNames: ['queue', 'result'] as const,
    registers: [registry],
  });
  const duration = new Histogram({
    name: 'bmt_job_duration_seconds',
    help: 'How long this worker spent on each job, by queue',
    labelNames: ['queue'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [registry],
  });
  for (const worker of deps.workers) {
    onJobFinished(worker, ({ queue, result, seconds }) => {
      jobs.inc({ queue, result });
      if (seconds !== undefined) duration.observe({ queue }, seconds);
    });
  }

  new Gauge({
    name: 'bmt_queue_jobs',
    help: 'Jobs in each queue by state, read from Redis when scraped (the same on every worker)',
    labelNames: ['queue', 'state'] as const,
    registers: [registry],
    async collect() {
      try {
        const counts = await Promise.all(deps.queues.map((q) => q.getJobCounts(...QUEUE_STATES)));
        deps.queues.forEach((q, i) => {
          for (const state of QUEUE_STATES) {
            this.set({ queue: q.name, state }, counts[i]![state] ?? 0);
          }
        });
      } catch (err) {
        // A scrape while Redis is down still returns everything else.
        logger.debug({ err }, 'queue depth not collected');
      }
    },
  });

  // Each gauge reads its own value: the client may collect gauges in any order.
  new Gauge({
    name: 'bmt_outbox_unpublished',
    help: 'Outbox events committed but not yet handed to a queue (the same on every worker)',
    registers: [registry],
    async collect() {
      try {
        const { rows } = await pool.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM outbox WHERE published_at IS NULL',
        );
        this.set(rows[0]!.count);
      } catch (err) {
        logger.debug({ err }, 'outbox backlog not collected');
      }
    },
  });
  new Gauge({
    name: 'bmt_outbox_oldest_seconds',
    help: 'Age of the oldest unpublished outbox event; 0 when the relay is caught up',
    registers: [registry],
    async collect() {
      try {
        const { rows } = await pool.query<{ age: number }>(
          `SELECT coalesce(extract(epoch FROM now() - min(created_at)), 0)::float8 AS age
           FROM outbox WHERE published_at IS NULL`,
        );
        this.set(rows[0]!.age);
      } catch (err) {
        logger.debug({ err }, 'outbox lag not collected');
      }
    },
  });
}
