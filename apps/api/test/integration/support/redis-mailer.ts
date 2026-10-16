import type { EmailMessage, Mailer } from '@bmt/jobs';
import type { Redis } from '@bmt/platform';

/**
 * A pretend email provider whose inbox lives in Redis, so several processes
 * (a worker that gets killed, and the one that takes over) share it. Like
 * Resend, it delivers each idempotency key once and answers repeats with the
 * first result.
 *
 * Each send waits before and after "delivering", so a SIGKILL can land either
 * before the provider got the email or after it did but before the worker
 * recorded it: the two windows a crash can hit.
 */
export function createRedisMailer(redis: Redis, ns: string, delayMs: number): Mailer {
  const sleep = () => new Promise((resolve) => setTimeout(resolve, delayMs));
  return {
    kind: 'fake',
    async send(message: EmailMessage) {
      await redis.incr(`${ns}:attempts`);
      await sleep();
      const first = await redis.set(`${ns}:mail:${message.idempotencyKey}`, message.to, 'NX');
      if (first === 'OK') await redis.rpush(`${ns}:delivered`, message.idempotencyKey);
      await sleep();
      return { id: message.idempotencyKey };
    },
  };
}

export async function delivered(redis: Redis, ns: string): Promise<string[]> {
  return redis.lrange(`${ns}:delivered`, 0, -1);
}
