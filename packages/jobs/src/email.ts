import { Queue } from 'bullmq';
import { QUEUE_PREFIX, queueConnection, type QueueOptions } from './connection';

/**
 * The email queue. The relay fills it from the outbox; its consumer (M4 PR 2)
 * sends the booking confirmation (with the ticket) and the refund notice.
 * Jobs that use up their attempts stay in the failed set, which is the dead
 * letter queue: inspected and replayed by hand (M4 PR 4).
 */

export const EMAIL_QUEUE = 'email';

export type EmailJobName = 'booking-confirmed' | 'refund-recorded';

export interface EmailJobData {
  /** The outbox event: the message id consumers deduplicate on. */
  outboxId: string;
  requestId: string | null;
  bookingId: string;
  refundId?: string;
  reason?: string;
}

export type EmailQueue = Queue<EmailJobData, void, EmailJobName>;

export function createEmailQueue(redisUrl: string, opts: QueueOptions = {}): EmailQueue {
  return new Queue<EmailJobData, void, EmailJobName>(EMAIL_QUEUE, {
    connection: queueConnection(redisUrl, opts),
    prefix: opts.prefix ?? QUEUE_PREFIX,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { age: 24 * 60 * 60 },
      removeOnFail: { age: 14 * 24 * 60 * 60 },
    },
  });
}
