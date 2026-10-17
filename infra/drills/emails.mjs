// The worker drill's traffic (ADR 0017): BOOKINGS buyers each hold a seat and pay (fake payments,
// so the stack must run with DEMO=1). Once everyone has paid it prints "paid", and the drill script
// kills one of the two workers while the confirmation emails (each with a PDF ticket) are going
// out. Then it waits for every booking to be confirmed and counts the emails in Mailpit.
//
// Lost emails fail the drill. Duplicates are reported, not failed: over SMTP a worker killed
// between sending and recording can repeat one, which ADR 0009 accepts for development (Resend in
// production deduplicates by the outbox id).
/* eslint-disable no-console -- a command-line report: printing is its job */
import { setTimeout as sleep } from 'node:timers/promises';

const BASE_URL = process.env.BASE_URL ?? 'http://nginx:8081';
const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://mailpit:8025';
const ORIGIN = process.env.ORIGIN ?? 'http://localhost:8080';
const CITY = process.env.CITY ?? 'rourkela';
const BOOKINGS = Number(process.env.BOOKINGS ?? 20);
const WAIT_S = Number(process.env.WAIT_S ?? 150);
const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

async function call(path, { method = 'GET', body, ip, cookie, headers = {} } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'X-Forwarded-For': ip,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json', Origin: ORIGIN } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
  return { res, json: text ? JSON.parse(text) : undefined };
}

const ip = (n) => `10.152.${(n >> 8) & 255}.${n & 255}`;
const since = (t) => `${((performance.now() - t) / 1000).toFixed(1)} s`;

function tomorrowInIndia() {
  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  return new Date(istNow.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
}

async function freeSeats(count) {
  const date = tomorrowInIndia();
  const { json: m } = await call(`/api/v1/cities/${CITY}/movies?date=${date}`, { ip: ip(0) });
  for (const movie of m.movies) {
    const { json: s } = await call(`/api/v1/movies/${movie.id}/shows?city=${CITY}&date=${date}`, {
      ip: ip(0),
    });
    for (const show of s.theatres.flatMap((t) => t.shows)) {
      const { json } = await call(`/api/v1/shows/${show.id}/seats`, { ip: ip(0) });
      const free = json.seats.filter((x) => x.status === 'AVAILABLE').slice(0, count);
      if (free.length === count) return { showId: show.id, seatIds: free.map((x) => x.id) };
    }
  }
  throw new Error(`no show tomorrow has ${count} free seats`);
}

/** Signs up, holds one seat and pays for it. Returns what is needed to check on it later. */
async function buy(i, showId, seatId) {
  const email = `drill-mail-${run}-${i}@example.test`;
  const signUp = await call('/api/auth/sign-up/email', {
    method: 'POST',
    ip: ip(i),
    body: { name: `Drill Buyer ${i}`, email, password: `pw-${run}-${i}` },
  });
  const cookie = signUp.res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const { json: held } = await call('/api/v1/bookings', {
    method: 'POST',
    ip: ip(i),
    cookie,
    body: { showId, seatIds: [seatId] },
    headers: { 'Idempotency-Key': `drill-mail-${run}-${i}` },
  });
  const bookingId = held.booking.id;
  await call(`/api/v1/bookings/${bookingId}/payment-order`, { method: 'POST', ip: ip(i), cookie });
  await call(`/api/v1/dev/fake-payments/${bookingId}`, {
    method: 'POST',
    ip: ip(i),
    cookie,
    body: { outcome: 'paid' },
  });
  return { i, email, cookie, bookingId };
}

async function emailsTo(address) {
  const res = await fetch(
    `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`,
  );
  if (!res.ok) return 0;
  const body = await res.json();
  return body.messages_count ?? body.messages?.length ?? 0;
}

const { showId, seatIds } = await freeSeats(BOOKINGS);
const started = performance.now();
const buyers = await Promise.all(seatIds.map((seatId, i) => buy(i + 1, showId, seatId)));
console.log(`paid: ${BOOKINGS} bookings in ${since(started)}; the webhooks confirm them next`);

// Every booking confirmed (by the webhook, a moment after paying)?
const paidAt = performance.now();
for (const b of buyers) {
  for (;;) {
    const { json } = await call(`/api/v1/bookings/${b.bookingId}`, {
      ip: ip(b.i),
      cookie: b.cookie,
    });
    if (json.booking.status === 'CONFIRMED') break;
    if (performance.now() - paidAt > 60_000)
      throw new Error(`booking ${b.bookingId} never confirmed`);
    await sleep(500);
  }
}
console.log(`confirmed: all ${BOOKINGS} after ${since(paidAt)}`);

// Every email delivered? Then wait a little longer, so a late duplicate is counted too.
const counts = new Map();
let lastArrival = 0;
const waitUntil = paidAt + WAIT_S * 1000;
while (performance.now() < waitUntil) {
  for (const b of buyers) {
    const n = await emailsTo(b.email);
    if (n > (counts.get(b.email) ?? 0)) lastArrival = performance.now();
    counts.set(b.email, n);
  }
  const missing = buyers.filter((b) => !counts.get(b.email)).length;
  console.log(
    `t=${since(paidAt).padStart(7)}  emails delivered to ${BOOKINGS - missing}/${BOOKINGS}`,
  );
  if (missing === 0) break;
  await sleep(2_000);
}
await sleep(10_000);
for (const b of buyers) counts.set(b.email, await emailsTo(b.email));

const lost = buyers.filter((b) => counts.get(b.email) === 0).length;
const duplicated = buyers.filter((b) => counts.get(b.email) > 1).length;
console.log('\nsummary');
console.log(`  bookings: ${BOOKINGS} paid, ${BOOKINGS} confirmed`);
console.log(
  `  emails:   ${BOOKINGS - lost} of ${BOOKINGS} delivered, ${lost} lost, ${duplicated} sent twice; ` +
    `the last arrived ${lastArrival ? `${((lastArrival - paidAt) / 1000).toFixed(1)} s` : '-'} after paying`,
);
console.log(`verdict: ${lost === 0 ? 'PASS' : 'FAIL'} (${lost} lost, ${duplicated} duplicated)`);
process.exit(lost === 0 ? 0 : 1);
