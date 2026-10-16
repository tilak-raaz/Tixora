import { parseArgs } from 'node:util';
import { listFailed, openQueue, QUEUE_NAMES, replayFailed, type QueueName } from '@bmt/jobs';
import { loadEnvFile } from '@bmt/platform';
import { ENV_FILE } from '../config';

/**
 * Lists or replays the dead letter queue (a queue's failed set).
 *
 *   npm run replay-dlq -- --queue email --dry-run     # list what failed, and why
 *   npm run replay-dlq -- --queue email               # move them back to waiting
 *   npm run replay-dlq -- --queue refunds --limit 10
 *
 * Fix the cause first (the reason is printed for each job); replaying a job
 * that fails for the same reason only puts it back in the failed set.
 */
const { values } = parseArgs({
  options: {
    queue: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    limit: { type: 'string', default: '100' },
  },
});

const name = values.queue as QueueName | undefined;
if (!name || !QUEUE_NAMES.includes(name)) {
  process.stderr.write(`--queue must be one of: ${QUEUE_NAMES.join(', ')}\n`);
  process.exit(2);
}
const limit = Number(values.limit);

loadEnvFile(ENV_FILE);
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  process.stderr.write('REDIS_URL is not set (copy .env.example to .env)\n');
  process.exit(2);
}

const queue = openQueue(name, redisUrl);
try {
  const failed = await listFailed(queue, limit);
  if (failed.length === 0) {
    process.stdout.write(`${name}: no failed jobs\n`);
  } else {
    process.stdout.write(`${name}: ${failed.length} failed job(s)\n`);
    for (const job of failed) {
      process.stdout.write(
        `  ${job.id}  ${job.name}  attempts=${job.attemptsMade}  ` +
          `failed=${job.failedAt?.toISOString() ?? '?'}  request=${job.requestId ?? '-'}\n` +
          `    ${job.failedReason}\n`,
      );
    }
    if (values['dry-run']) {
      process.stdout.write('dry run: nothing replayed\n');
    } else {
      const replayed = await replayFailed(queue, limit);
      process.stdout.write(`replayed ${replayed.length} job(s) back to waiting\n`);
    }
  }
} finally {
  await queue.close();
}
