// Hot show (ADR 0016): VIEWERS people keep one show's live seat map open while a buyer holds and
// releases a seat CHANGES times. For every change it measures how long after the buyer pressed
// Hold (or Release) each viewer's map heard about it, and whether every viewer did. While the
// streams are open it also asks each API replica how many it is carrying, to show how nginx's
// least-connections balancing spread them.
//
// k6 has no Server-Sent Events client without a custom build, so this one is plain Node.js.
//
//   make load-fanout VIEWERS=300 CHANGES=10
/* eslint-disable no-console -- a command-line report: printing is its job */
import { lookup } from 'node:dns/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE_URL = process.env.BASE_URL ?? 'http://nginx:8081';
const ORIGIN = process.env.ORIGIN ?? 'http://localhost:8080';
const CITY = process.env.CITY ?? 'rourkela';
const VIEWERS = Number(process.env.VIEWERS ?? 300);
const CHANGES = Number(process.env.CHANGES ?? 10);

/** Each viewer looks like its own visitor (10.200.x.y), as in the k6 scenarios. */
const ip = (n) => `10.200.${(n >> 8) & 255}.${n & 255}`;

async function api(path, { method = 'GET', body, from, cookie } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'X-Forwarded-For': from,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json', Origin: ORIGIN } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method === 'POST' && path === '/api/v1/bookings'
        ? { 'Idempotency-Key': `fanout-${Date.now()}-${Math.random()}` }
        : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
  return { res, json: text ? JSON.parse(text) : undefined };
}

function tomorrowInIndia() {
  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  return new Date(istNow.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
}

/** A show tomorrow with a free seat, and that seat. */
async function pickShowAndSeat() {
  const date = tomorrowInIndia();
  const from = ip(0);
  const { json: m } = await api(`/api/v1/cities/${CITY}/movies?date=${date}`, { from });
  for (const movie of m.movies) {
    const { json: s } = await api(`/api/v1/movies/${movie.id}/shows?city=${CITY}&date=${date}`, {
      from,
    });
    for (const show of s.theatres.flatMap((t) => t.shows)) {
      const { json } = await api(`/api/v1/shows/${show.id}/seats`, { from });
      const seat = json.seats.find((x) => x.status === 'AVAILABLE');
      if (seat) return { showId: show.id, seatId: seat.id, label: `${seat.row}${seat.number}` };
    }
  }
  throw new Error('no free seat tomorrow; is the stack seeded? (make stack-seed)');
}

async function signUp() {
  const id = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const { res } = await api('/api/auth/sign-up/email', {
    method: 'POST',
    from: ip(65_000),
    body: { name: 'Fan-out Buyer', email: `fanout-${id}@example.test`, password: `pw-${id}` },
  });
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

/** The change everyone should hear about next, and who has heard it so far. */
let expected;

function openViewer(n, showId) {
  const controller = new AbortController();
  const ready = (async () => {
    const res = await fetch(`${BASE_URL}/api/v1/shows/${showId}/seats/events`, {
      headers: { 'X-Forwarded-For': ip(n), Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`viewer ${n}: ${res.status}`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    let resolveReady;
    const isReady = new Promise((r) => (resolveReady = r));
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += value;
          let end;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const event = frame.match(/^event: (.+)$/m)?.[1];
            const data = frame.match(/^data: (.+)$/m)?.[1];
            if (event === 'ready') resolveReady();
            if (event === 'seats' && expected && !expected.heard.has(n)) {
              const seats = JSON.parse(data).seats;
              if (seats.some((s) => s.id === expected.seatId && s.status === expected.status)) {
                expected.heard.set(n, performance.now() - expected.t0);
              }
            }
          }
        }
      } catch {
        // Aborted at the end of the run.
      }
    })();
    await isReady;
  })();
  return { ready, close: () => controller.abort() };
}

/** Open seat streams per replica, read from each replica's /metrics inside the stack. */
async function streamsPerReplica() {
  const replicas = await lookup('api', { all: true });
  return Promise.all(
    replicas.map(async ({ address }) => {
      const text = await (await fetch(`http://${address}:4000/metrics`)).text();
      const line = text.split('\n').find((l) => l.startsWith('bmt_seat_streams{'));
      return { replica: address, streams: line ? Number(line.split(' ').at(-1)) : 0 };
    }),
  );
}

const quantile = (sorted, q) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : NaN;
const ms = (v) => (Number.isFinite(v) ? `${Math.round(v)} ms` : '-');

const { showId, seatId, label } = await pickShowAndSeat();
const cookie = await signUp();
console.log(`show ${showId}, seat ${label}; opening ${VIEWERS} live seat maps...`);

const opened = performance.now();
const viewers = Array.from({ length: VIEWERS }, (_, i) => openViewer(i + 1, showId));
await Promise.all(viewers.map((v) => v.ready));
console.log(`all ${VIEWERS} ready in ${ms(performance.now() - opened)}\n`);

console.log('open streams per API replica:');
console.table(await streamsPerReplica());

const rows = [];
const all = [];
let bookingId;
for (let i = 0; i < CHANGES; i++) {
  const holding = i % 2 === 0;
  expected = { seatId, status: holding ? 'UNAVAILABLE' : 'AVAILABLE', heard: new Map() };
  expected.t0 = performance.now();
  if (holding) {
    const { json } = await api('/api/v1/bookings', {
      method: 'POST',
      from: ip(65_000),
      cookie,
      body: { showId, seatIds: [seatId] },
    });
    bookingId = json.booking.id;
  } else {
    await api(`/api/v1/bookings/${bookingId}/hold`, { method: 'DELETE', from: ip(65_000), cookie });
  }
  const deadline = performance.now() + 5_000;
  while (expected.heard.size < VIEWERS && performance.now() < deadline) await sleep(10);

  const times = [...expected.heard.values()].sort((a, b) => a - b);
  all.push(...times);
  rows.push({
    change: holding ? 'hold' : 'release',
    'viewers told': `${times.length}/${VIEWERS}`,
    p50: ms(quantile(times, 0.5)),
    p95: ms(quantile(times, 0.95)),
    slowest: ms(times.at(-1)),
  });
  await sleep(500);
}
if (CHANGES % 2 === 1) {
  await api(`/api/v1/bookings/${bookingId}/hold`, { method: 'DELETE', from: ip(65_000), cookie });
}

console.log('\nfrom the buyer pressing Hold or Release to each viewer hearing it:');
console.table(rows);
all.sort((a, b) => a - b);
const missed = CHANGES * VIEWERS - all.length;
console.log(
  `overall: p50 ${ms(quantile(all, 0.5))}, p95 ${ms(quantile(all, 0.95))}, p99 ${ms(quantile(all, 0.99))}, slowest ${ms(all.at(-1))}; missed ${missed} of ${CHANGES * VIEWERS}`,
);

for (const v of viewers) v.close();
process.exit(missed === 0 ? 0 : 1);
