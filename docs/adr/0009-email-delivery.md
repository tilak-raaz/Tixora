# 0009. Email: Resend in production, Mailpit in development, sent at most once per event

- Status: Accepted
- Date: 2026-10-16

## Context

Two emails exist: "Booking confirmed" (with the ticket, M4 PR 3) and "Refund on its way". They are
queued from outbox events (ADR 0008), so a job can run more than once: a retry after a timeout, a
worker killed mid-job, a relay that queued an event twice. A buyer must not get the same email twice,
and a confirmed booking must not miss its email.

Recording "sent" in Postgres alone cannot close the gap: the worker can die after the provider
accepted the email and before the record is written, and the retry sends it again.

## Decision

- **One `Mailer` interface, three implementations.** `smtp` (Nodemailer) to Mailpit in development,
  so nothing leaves the laptop and every email is visible at `localhost:8025`; `resend` (its HTTP
  API over `fetch`) in production; `fake` in tests. `MAILER` picks one.
- **The outbox id is the idempotency key.** Resend accepts a key once per 24 hours, so a send
  repeated after a crash is dropped by the provider. The fake mailer behaves the same way.
- **`processed_messages` skips finished work.** A job checks it first and records itself after
  sending, so the common repeat (a duplicate job) never reaches the provider at all.
- **The event carries ids only.** The email reads the booking, show and seats when it is sent,
  and escapes every name before it goes into HTML.

## Consequences

- With Resend, an email reaches the buyer once per event, even when the worker dies at the worst
  moment (tested with the fake mailer; the kill test arrives in M4 PR 4).
- Plain SMTP has no idempotency key, so in development a crash in that window can repeat an
  email. That is acceptable for Mailpit and is why production uses the API, not Resend's SMTP.
- Production needs a verified sending domain at Resend (a subdomain of `tilakraaz.cloud`); set
  up in M8.
