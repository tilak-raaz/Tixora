import { createResendMailer, MailerError, esc } from '@bmt/jobs';
import { describe, expect, it } from 'vitest';

describe('resend mailer', () => {
  it('sends with the API key and the idempotency key, attachments in base64', async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: 'email_1' }), { status: 200 });
    }) as typeof fetch;
    const mailer = createResendMailer({
      apiKey: 're_test',
      from: 'BMT <t@x.in>',
      fetch: fakeFetch,
    });

    const result = await mailer.send({
      to: 'buyer@example.com',
      subject: 'Booked',
      text: 'hi',
      html: '<p>hi</p>',
      idempotencyKey: 'outbox-1',
      attachments: [
        { filename: 'ticket.pdf', content: Buffer.from('PDF'), contentType: 'application/pdf' },
      ],
    });

    expect(result).toEqual({ id: 'email_1' });
    expect(sent[0]!.url).toBe('https://api.resend.com/emails');
    const headers = sent[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer re_test');
    expect(headers['idempotency-key']).toBe('outbox-1');
    expect(JSON.parse(String(sent[0]!.init.body))).toMatchObject({
      from: 'BMT <t@x.in>',
      to: ['buyer@example.com'],
      attachments: [{ filename: 'ticket.pdf', content: Buffer.from('PDF').toString('base64') }],
    });
  });

  it('turns an error answer into a MailerError with the status', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ message: 'invalid from address' }), {
        status: 422,
      })) as typeof fetch;
    const err = await createResendMailer({ apiKey: 're_test', from: 'x', fetch: fakeFetch })
      .send({ to: 'a@b.c', subject: 's', text: 't', html: 'h', idempotencyKey: 'k' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MailerError);
    expect(err).toMatchObject({ status: 422, message: 'invalid from address' });
  });
});

describe('esc', () => {
  it('escapes everything that could break out of HTML', () => {
    expect(esc(`<a href="x" onclick='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
});
