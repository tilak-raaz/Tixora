// Rate limit across replicas (ADR 0016, ADR 0010): one address tries to sign in twice a second for
// 15 seconds through the public edge (nginx :8080), which spreads the attempts over every API
// replica. The sign-in limit is 5 a minute per IP, counted in Redis, so exactly 5 attempts may get
// an answer (here 401, a wrong password) and the other 25 must get 429, however many replicas
// there are.
//
//   make load-ratelimit        (wait a minute between runs: the window is one minute)
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { ORIGIN } from './lib.js';

const EDGE_URL = __ENV.EDGE_URL || 'http://nginx:8080';

const answered = new Counter('signins_answered');
const limited = new Counter('signins_limited');
const other = new Counter('signins_other');

export const options = {
  scenarios: {
    // One attempt every half second, exactly 30 of them. (constant-arrival-rate fires at both ends
    // of its window, which made 31 and broke the count.)
    guessing: { executor: 'per-vu-iterations', vus: 1, iterations: 30, maxDuration: '1m' },
  },
  thresholds: {
    signins_answered: ['count==5'],
    signins_limited: ['count==25'],
    signins_other: ['count==0'],
  },
};

export default function () {
  const res = http.post(
    `${EDGE_URL}/api/auth/sign-in/email`,
    JSON.stringify({ email: 'rate-limit-probe@example.test', password: 'not-the-password' }),
    {
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      tags: { name: 'sign-in' },
      responseCallback: http.expectedStatuses(401, 429),
    },
  );
  if (res.status === 429) limited.add(1);
  else if (res.status === 401) answered.add(1);
  else other.add(1);
  sleep(0.5);
  check(res, {
    'limited ones say when to retry': (r) => r.status !== 429 || !!r.headers['Retry-After'],
  });
}
