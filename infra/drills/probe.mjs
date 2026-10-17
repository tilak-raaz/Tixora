// The steady users a failure drill breaks things under (ADR 0017). For DURATION seconds:
//
// - reads:   RPS requests a second, alternating a seat map (Postgres) and the city list (cache);
// - buyers:  a hold or a release of one seat every second, taking turns among BUYERS signed-in
//            buyers (each one holds about 5 times a minute, inside the hold limit of 10);
// - sign-in: one wrong-password sign-in a second, each from a new address (a 401 when healthy);
// - viewers: VIEWERS live seat maps on that show, which reconnect like a browser (after 1 s) and
//            reload the map when they do, as the web app does.
//
// It prints a line per second, then a summary, and ends with "verdict: ..." for the drill script.
// The run fails if a viewer still shows the wrong seat state at the end, or a viewer never came
// back: the outage may cost requests, but it must not leave anyone looking at a wrong seat map.
/* eslint-disable no-console -- a command-line report: printing is its job */
import { setTimeout as sleep } from 'node:timers/promises';

const BASE_URL = process.env.BASE_URL ?? 'http://nginx:8081';
const ORIGIN = process.env.ORIGIN ?? 'http://localhost:8080';
const CITY = process.env.CITY ?? 'rourkela';
const DURATION = Number(process.env.DURATION ?? 60);
const RPS = Number(process.env.RPS ?? 40);
const VIEWERS = Number(process.env.VIEWERS ?? 60);
const BUYERS = Number(process.env.BUYERS ?? 6);
const TIMEOUT_MS = 5_000;

let nextIp = 1;
/** A new made-up visitor address each call (10.150.x.y), so per-IP limits never bite the probe. */
const freshIp = () => {
  const n = nextIp++ % 65_000;
  return `10.150.${(n >> 8) & 255}.${n & 255}`;
};
/** Each buyer has its own address: sign-up is limited to 5 a minute per IP. */
const buyerIp = (k) => `10.149.0.${k + 1}`;

async function call(path, { method = 'GET', body, ip = freshIp(), cookie, headers = {} } = {}) {
  const started = performance.now();
  try {
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
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json, res, ms: performance.now() - started };
  } catch (err) {
    const status = err.name === 'TimeoutError' ? 'timeout' : 'refused';
    return { status, ms: performance.now() - started };
  }
}

function tomorrowInIndia() {
  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  return new Date(istNow.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
}

async function pickShowAndSeat() {
  const date = tomorrowInIndia();
  const movies = await call(`/api/v1/cities/${CITY}/movies?date=${date}`);
  if (movies.status !== 200)
    throw new Error(`movies: ${movies.status}; is the stack up and seeded?`);
  for (const movie of movies.json.movies) {
    const shows = await call(`/api/v1/movies/${movie.id}/shows?city=${CITY}&date=${date}`);
    for (const show of shows.json.theatres.flatMap((t) => t.shows)) {
      const seats = await call(`/api/v1/shows/${show.id}/seats`);
      const seat = seats.json.seats.find((s) => s.status === 'AVAILABLE');
      if (seat) return { showId: show.id, seatId: seat.id };
    }
  }
  throw new Error('no free seat tomorrow');
}

async function signUpBuyer(k) {
  const id = `${Date.now()}-${k}-${Math.floor(Math.random() * 1e9)}`;
  const r = await call('/api/auth/sign-up/email', {
    method: 'POST',
    ip: buyerIp(k),
    body: { name: `Drill Buyer ${k}`, email: `drill-${id}@example.test`, password: `pw-${id}` },
  });
  if (r.status !== 200) throw new Error(`sign-up: ${r.status}`);
  const cookie = r.res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  return { ip: buyerIp(k), cookie };
}

// ---------------------------------------------------------------------------------------------
// Per-second tallies
// ---------------------------------------------------------------------------------------------

const seconds = [];
const tally = () => {
  const t = Math.floor((performance.now() - t0) / 1000);
  seconds[t] ??= { reads: {}, buyer: {}, signin: {}, reconnects: 0, resyncs: 0 };
  return seconds[t];
};
const bump = (bucket, key) => (bucket[key] = (bucket[key] ?? 0) + 1);

// ---------------------------------------------------------------------------------------------
// Viewers: a live seat map each, reconnecting like the browser's EventSource
// ---------------------------------------------------------------------------------------------

function startViewer(n, showId, seatId, stopAt) {
  const viewer = { n, connected: false, everDropped: false, seatStatus: undefined, reconnects: 0 };
  const ip = `10.151.${(n >> 8) & 255}.${n & 255}`;
  const reload = async () => {
    const r = await call(`/api/v1/shows/${showId}/seats`, { ip });
    const seat = r.json?.seats?.find((s) => s.id === seatId);
    if (seat) viewer.seatStatus = seat.status;
  };
  viewer.done = (async () => {
    let first = true;
    while (performance.now() < stopAt) {
      if (!first) {
        viewer.reconnects++;
        tally().reconnects++;
        await sleep(1_000);
      }
      first = false;
      const controller = new AbortController();
      const stop = setTimeout(() => controller.abort(), Math.max(0, stopAt - performance.now()));
      try {
        const res = await fetch(`${BASE_URL}/api/v1/shows/${showId}/seats/events`, {
          headers: { 'X-Forwarded-For': ip, Accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(String(res.status));
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let end;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const event = frame.match(/^event: (.+)$/m)?.[1];
            const data = frame.match(/^data: (.+)$/m)?.[1];
            if (event === 'ready') {
              // As the web app: connected, then load the map and merge events from here on.
              viewer.connected = true;
              await reload();
            } else if (event === 'resync') {
              tally().resyncs++;
              await reload();
            } else if (event === 'seats') {
              const seat = JSON.parse(data).seats.find((s) => s.id === seatId);
              if (seat) viewer.seatStatus = seat.status;
            }
          }
        }
      } catch {
        // Refused, reset or aborted at the end of the run: reconnect below if time is left.
      } finally {
        clearTimeout(stop);
      }
      if (performance.now() < stopAt) {
        viewer.connected = false;
        viewer.everDropped = true;
      }
    }
    viewer.connected = false;
  })();
  return viewer;
}

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------

const { showId, seatId } = await pickShowAndSeat();
const buyers = await Promise.all(Array.from({ length: BUYERS }, (_, k) => signUpBuyer(k)));

const t0 = performance.now();
const stopAt = t0 + DURATION * 1000;
const viewers = Array.from({ length: VIEWERS }, (_, i) =>
  startViewer(i + 1, showId, seatId, stopAt),
);
const deadline = performance.now() + 15_000;
while (viewers.some((v) => !v.connected) && performance.now() < deadline) await sleep(100);
console.log(`ready: ${VIEWERS} viewers on show ${showId}; t=0 is now`);

const inflight = new Set();
const track = (promise) => {
  inflight.add(promise);
  promise.finally(() => inflight.delete(promise));
};

// Reads, spread evenly over each second.
const readLoop = (async () => {
  let i = 0;
  while (performance.now() < stopAt) {
    const path = i++ % 2 === 0 ? `/api/v1/shows/${showId}/seats` : '/api/v1/cities';
    track(call(path).then((r) => bump(tally().reads, r.status)));
    await sleep(1000 / RPS);
  }
})();

// A buyer's hold or release and a sign-in attempt, once a second each. The buyer holding the seat
// is the one who releases it; the next hold is the next buyer's turn.
// It stops 3 s before the end, so its last change reaches every viewer before they are compared.
let holder; // { buyer, bookingId } while the seat is held by us
let holds = 0;
const actionLoop = (async () => {
  while (performance.now() < stopAt - 3_000) {
    const tick = performance.now();
    track(
      call('/api/auth/sign-in/email', {
        method: 'POST',
        body: { email: 'drill-probe@example.test', password: 'not-the-password' },
      }).then((r) => bump(tally().signin, r.status)),
    );
    if (holder) {
      const { buyer, bookingId } = holder;
      const r = await call(`/api/v1/bookings/${bookingId}/hold`, {
        method: 'DELETE',
        ip: buyer.ip,
        cookie: buyer.cookie,
      });
      bump(tally().buyer, `release ${r.status}`);
      // Released, or already gone (expired, or a release whose answer was lost): free again.
      if (r.status === 200 || r.status === 404 || r.status === 409) holder = undefined;
    } else {
      const buyer = buyers[holds++ % buyers.length];
      const r = await call('/api/v1/bookings', {
        method: 'POST',
        ip: buyer.ip,
        cookie: buyer.cookie,
        body: { showId, seatIds: [seatId] },
        headers: { 'Idempotency-Key': `drill-${Date.now()}-${Math.random()}` },
      });
      bump(tally().buyer, `hold ${r.status}`);
      if (r.status === 201) holder = { buyer, bookingId: r.json.booking.id };
    }
    await sleep(Math.max(0, 1000 - (performance.now() - tick)));
  }
})();

// One line a second.
const format = (bucket) =>
  Object.entries(bucket)
    .sort()
    .map(([k, v]) => `${k}×${v}`)
    .join(' ') || '-';
const printer = (async () => {
  let t = 0;
  while (performance.now() < stopAt + 1000) {
    await sleep(Math.max(0, t0 + (t + 1) * 1000 - performance.now()));
    const s = seconds[t] ?? { reads: {}, buyer: {}, signin: {}, reconnects: 0, resyncs: 0 };
    const up = viewers.filter((v) => v.connected).length;
    console.log(
      `t=${String(t).padStart(3)}s  reads ${format(s.reads)}  |  buyers ${format(s.buyer)}  |  ` +
        `sign-in ${format(s.signin)}  |  viewers ${up}/${VIEWERS}` +
        (s.reconnects ? `, ${s.reconnects} reconnecting` : '') +
        (s.resyncs ? `, ${s.resyncs} resync` : ''),
    );
    t++;
    if (t >= DURATION) break;
  }
})();

await Promise.all([readLoop, actionLoop, printer]);
await Promise.allSettled([...inflight]);
await Promise.all(viewers.map((v) => v.done));

// Compare every viewer's map with the truth, then release the hold if we still have one.
const truth = (await call(`/api/v1/shows/${showId}/seats`)).json?.seats?.find(
  (s) => s.id === seatId,
)?.status;
if (holder) {
  await call(`/api/v1/bookings/${holder.bookingId}/hold`, {
    method: 'DELETE',
    ip: holder.buyer.ip,
    cookie: holder.buyer.cookie,
  });
}

// ---------------------------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------------------------

const total = (key) => {
  const out = {};
  for (const s of seconds)
    for (const [k, v] of Object.entries(s?.[key] ?? {})) out[k] = (out[k] ?? 0) + v;
  return out;
};
const failedSeconds = seconds
  .map((s, t) => [t, s])
  .filter(([, s]) => s && Object.keys(s.reads).some((k) => k !== '200'))
  .map(([t]) => t);
const reads = total('reads');
const readCount = Object.values(reads).reduce((a, b) => a + b, 0);
const readFailed = readCount - (reads['200'] ?? 0);

// The buyer went quiet 3 s before the end and every viewer reloaded on each reconnect, so each
// viewer's last state must match the database.
const wrong = viewers.filter((v) => v.seatStatus !== truth).length;
const dropped = viewers.filter((v) => v.everDropped).length;
const reconnects = viewers.reduce((a, v) => a + v.reconnects, 0);

console.log('\nsummary');
console.log(
  `  reads:   ${readCount} sent, ${readFailed} failed (${((100 * readFailed) / Math.max(1, readCount)).toFixed(1)}%)  ${format(reads)}`,
);
if (failedSeconds.length) {
  console.log(
    `           failures from t=${failedSeconds[0]}s to t=${failedSeconds.at(-1)}s (${failedSeconds.length} seconds with any)`,
  );
}
console.log(`  buyers:  ${format(total('buyer'))}`);
console.log(`  sign-in: ${format(total('signin'))}`);
console.log(
  `  viewers: ${dropped} of ${VIEWERS} lost their stream at least once, ${reconnects} reconnects; ` +
    `${VIEWERS - wrong} of ${VIEWERS} show the right seat state at the end (${truth})`,
);
const ok = wrong === 0;
console.log(`verdict: ${ok ? 'PASS' : 'FAIL'} (${wrong} viewers wrong at the end)`);
process.exit(ok ? 0 : 1);
