// Seat storm (ADR 0016): BUYERS signed-in buyers try to hold one of SEATS seats on the same show at
// the same moment, BUYERS / SEATS contenders per seat. Each seat must end up with exactly one owner:
// the run fails unless exactly SEATS holds succeed, everyone else gets a clean 409, and nothing
// errors. Afterwards `make stack-metrics` shows how the losers were turned away (the Redis
// pre-lock, or Postgres).
//
//   make load-storm BUYERS=200 SEATS=10
//
// The winning holds are left to expire (5 minutes), which gives the workers' hold-expiry jobs work.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import {
  BASE_URL,
  SESSION_COOKIE,
  getJson,
  showsTomorrow,
  signUpBuyers,
  visitorIp,
} from './lib.js';

const BUYERS = Number(__ENV.BUYERS || 200);
const SEATS = Number(__ENV.SEATS || 10);

const held = new Counter('holds_won');
const refused = new Counter('holds_refused');
const errors = new Counter('holds_errored');
const holdTime = new Trend('hold_time', true);

export const options = {
  setupTimeout: '3m',
  scenarios: {
    storm: {
      executor: 'per-vu-iterations',
      vus: BUYERS,
      iterations: 1,
      maxDuration: '1m',
    },
  },
  thresholds: {
    holds_won: [`count==${SEATS}`],
    holds_errored: ['count==0'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const ip = visitorIp(900_000);
  // The show with the most free seats tomorrow, and its first SEATS free seats.
  for (const show of showsTomorrow(ip)) {
    const { body } = getJson(`/api/v1/shows/${show.id}/seats`, ip);
    const free = body.seats.filter((s) => s.status === 'AVAILABLE').slice(0, SEATS);
    if (free.length < SEATS) continue;
    const cookies = signUpBuyers(BUYERS);
    // Everyone fires at this moment, so the requests really do arrive together.
    return { showId: show.id, seatIds: free.map((s) => s.id), cookies, startAt: Date.now() + 2000 };
  }
  throw new Error(`no show tomorrow has ${SEATS} free seats; reseed or wait for holds to expire`);
}

export default function (data) {
  const wait = data.startAt - Date.now();
  if (wait > 0) sleep(wait / 1000);

  const seatId = data.seatIds[(__VU - 1) % data.seatIds.length];
  const res = http.post(
    `${BASE_URL}/api/v1/bookings`,
    JSON.stringify({ showId: data.showId, seatIds: [seatId] }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `storm-${__VU}-${Date.now()}-${Math.random()}`,
        'X-Forwarded-For': visitorIp(1_000_000 + __VU - 1),
        Cookie: `${SESSION_COOKIE}=${data.cookies[__VU - 1]}`,
      },
      tags: { name: 'hold' },
    },
  );
  holdTime.add(res.timings.duration);
  if (res.status === 201) held.add(1);
  else if (res.status === 409 && res.json('error.code') === 'SEATS_UNAVAILABLE') refused.add(1);
  else {
    errors.add(1);
    console.warn(`unexpected ${res.status}: ${String(res.body).slice(0, 200)}`);
  }
}

export function teardown(data) {
  const { body } = getJson(`/api/v1/shows/${data.showId}/seats`, visitorIp(900_001));
  const taken = new Set(body.seats.filter((s) => s.status !== 'AVAILABLE').map((s) => s.id));
  check(null, {
    'every contested seat is taken': () => data.seatIds.every((id) => taken.has(id)),
  });
}
