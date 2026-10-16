import type { Logger, Pool } from '@bmt/platform';
import { Queue, Worker } from 'bullmq';
import { QUEUE_PREFIX, queueConnection, type QueueOptions } from './connection';
import { bookingConfirmedEmail, loadBookingDetails, refundRecordedEmail } from './email-content';
import type { EmailMessage, Mailer } from './mailer';
import { renderTicketPdf, ticketFilename } from './ticket';

/**
 * The email queue. The relay fills it from the outbox; its consumer sends the
 * booking confirmation and the refund notice. Jobs that use up their attempts
 * stay in the failed set, which is the dead letter queue: inspected and
 * replayed by hand (M4 PR 4).
 *
 * Delivery is at least once, so sending is made safe to repeat twice over:
 * a message already in processed_messages is skipped, and the outbox id is the
 * provider's idempotency key, which covers a crash between sending and
 * recording (ADR 0008).
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

/** The consumer name in processed_messages. */
export const EMAIL_CONSUMER = 'email';

export type EmailResult = 'sent' | 'already_sent' | 'skipped';

/** One email job, start to finish. Exported so tests can drive it without a queue. */
export async function handleEmailJob(
  deps: { pool: Pool; mailer: Mailer; logger: Logger },
  job: { name: EmailJobName; data: EmailJobData },
): Promise<EmailResult> {
  const { pool, mailer } = deps;
  const { outboxId, requestId, bookingId } = job.data;
  const log = deps.logger.child({ outboxId, requestId, email: job.name, bookingId });

  const done = await pool.query(
    'SELECT 1 FROM processed_messages WHERE consumer = $1 AND message_id = $2',
    [EMAIL_CONSUMER, outboxId],
  );
  if (done.rowCount === 1) return 'already_sent';

  const details = await loadBookingDetails(pool, bookingId);
  let email;
  let attachments: EmailMessage['attachments'];
  if (!details) {
    email = undefined;
  } else if (job.name === 'booking-confirmed') {
    email = bookingConfirmedEmail(details);
    attachments = [
      {
        filename: ticketFilename(bookingId),
        content: await renderTicketPdf(details),
        contentType: 'application/pdf',
      },
    ];
  } else {
    const { rows } = await pool.query<{ amountPaise: number; reason: string }>(
      'SELECT amount_paise AS "amountPaise", reason FROM refunds WHERE id = $1',
      [job.data.refundId],
    );
    email = rows[0] ? refundRecordedEmail(details, rows[0]) : undefined;
  }

  if (email) {
    await mailer.send({ to: details!.userEmail, ...email, attachments, idempotencyKey: outboxId });
  } else {
    log.warn('nothing to email about: booking or refund not found');
  }
  await pool.query(
    'INSERT INTO processed_messages (consumer, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [EMAIL_CONSUMER, outboxId],
  );
  if (email) log.info({ mailer: mailer.kind }, 'email sent');
  return email ? 'sent' : 'skipped';
}

export type EmailWorker = Worker<EmailJobData, EmailResult, EmailJobName>;

export function createEmailWorker(
  deps: { redisUrl: string; pool: Pool; mailer: Mailer; logger: Logger },
  opts: QueueOptions & { concurrency?: number } = {},
): EmailWorker {
  const { logger } = deps;
  const worker = new Worker<EmailJobData, EmailResult, EmailJobName>(
    EMAIL_QUEUE,
    async (job) => handleEmailJob(deps, job),
    {
      connection: queueConnection(deps.redisUrl, opts),
      prefix: opts.prefix ?? QUEUE_PREFIX,
      concurrency: opts.concurrency ?? 5,
    },
  );
  worker.on('failed', (job, err) => {
    const attempts = job?.opts.attempts ?? 1;
    const log = {
      err,
      outboxId: job?.data.outboxId,
      requestId: job?.data.requestId,
      attempt: job?.attemptsMade,
    };
    if (job && job.attemptsMade >= attempts) {
      logger.error(log, 'email failed for good; it is in the failed set (dead letter queue)');
    } else {
      logger.warn(log, 'email failed; it will be retried');
    }
  });
  worker.on('error', (err) => logger.error({ err }, 'email worker error'));
  return worker;
}
