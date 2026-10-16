import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';

/**
 * Sending email, behind one interface so the email consumer does not care how:
 *
 * - smtp:   Nodemailer to Mailpit in development (inbox at localhost:8025)
 * - resend: Resend's HTTP API in production, with the idempotency key that
 *           makes a retried send harmless
 * - fake:   in memory, for tests; honours the idempotency key like Resend
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /**
   * The same key means the same email: Resend accepts it once per 24 hours.
   * The consumer passes the outbox id, so a send repeated after a crash is
   * dropped by the provider instead of reaching the buyer twice.
   */
  idempotencyKey: string;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
}

export interface Mailer {
  readonly kind: 'smtp' | 'resend' | 'fake';
  send(message: EmailMessage): Promise<{ id: string }>;
  close?(): Promise<void>;
}

/** Plain SMTP: no idempotency keys, so a crash after sending can repeat an email (development only). */
export function createSmtpMailer(config: { url: string; from: string }): Mailer {
  const transport = nodemailer.createTransport(config.url);
  return {
    kind: 'smtp',
    async send(message) {
      const info = await transport.sendMail({
        from: config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        attachments: message.attachments,
        headers: { 'X-Idempotency-Key': message.idempotencyKey },
      });
      return { id: String(info.messageId) };
    },
    async close() {
      transport.close();
    },
  };
}

export class MailerError extends Error {
  readonly status: number | undefined;
  constructor(message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = 'MailerError';
    this.status = opts.status;
  }
}

export function createResendMailer(config: {
  apiKey: string;
  from: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Mailer {
  const doFetch = config.fetch ?? fetch;
  return {
    kind: 'resend',
    async send(message) {
      let res: Response;
      try {
        res = await doFetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            'content-type': 'application/json',
            'idempotency-key': message.idempotencyKey,
          },
          body: JSON.stringify({
            from: config.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            html: message.html,
            attachments: message.attachments?.map((a) => ({
              filename: a.filename,
              content: a.content.toString('base64'),
              content_type: a.contentType,
            })),
          }),
          signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
        });
      } catch (err) {
        throw new MailerError(`Resend unreachable: ${(err as Error).message}`, { cause: err });
      }
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!res.ok || !body.id) {
        throw new MailerError(body.message ?? `Resend answered ${res.status}`, {
          status: res.status,
        });
      }
      return { id: body.id };
    },
  };
}

export interface FakeMailer extends Mailer {
  /** Emails that would have reached a buyer: one per idempotency key. */
  readonly sent: EmailMessage[];
  /** Every send call, including ones dropped as repeats. */
  readonly attempts: number;
  /** The next send fails as if the provider were down. */
  failNext(): void;
}

export function createFakeMailer(): FakeMailer {
  const sent: EmailMessage[] = [];
  const ids = new Map<string, string>();
  let attempts = 0;
  let failing = false;
  return {
    kind: 'fake',
    sent,
    get attempts() {
      return attempts;
    },
    async send(message) {
      attempts += 1;
      await new Promise((resolve) => setImmediate(resolve));
      if (failing) {
        failing = false;
        throw new MailerError('fake provider outage', { status: 503 });
      }
      // Like Resend: a repeated key returns the first email's id and sends nothing.
      const existing = ids.get(message.idempotencyKey);
      if (existing) return { id: existing };
      const id = randomUUID();
      ids.set(message.idempotencyKey, id);
      sent.push(message);
      return { id };
    },
    failNext() {
      failing = true;
    },
  };
}
