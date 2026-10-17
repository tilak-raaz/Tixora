// Shared by the k6 scenarios (ADR 0016).
//
// The scenarios run in a container on the stack's network and, except the rate-limit one, call
// nginx's internal port (8081), the one the Next.js server uses. It passes X-Forwarded-For through,
// so each simulated visitor can have its own address: per-IP rate limits stay on and behave as they
// would for that many separate people, instead of throttling one load generator.
import http from 'k6/http';

export const BASE_URL = __ENV.BASE_URL || 'http://nginx:8081';
/** Better Auth only accepts sign-ups and sign-ins from the web app's origin. */
export const ORIGIN = __ENV.ORIGIN || 'http://localhost:8080';
export const CITY = __ENV.CITY || 'rourkela';
export const SESSION_COOKIE = 'bmt.session_token';

/** A made-up IPv4 address for visitor number `n` (10.0.0.0/8, never a real client). */
export function visitorIp(n) {
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

/** Tomorrow in India, so every show that day is still ahead of the clock. */
export function tomorrowInIndia() {
  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  return new Date(istNow.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
}

export function headersFor(ip, extra = {}) {
  return { 'X-Forwarded-For': ip, Accept: 'application/json', ...extra };
}

export function getJson(path, ip, params = {}) {
  const res = http.get(`${BASE_URL}${path}`, {
    ...params,
    headers: headersFor(ip, params.headers),
  });
  return { res, body: res.status === 200 ? res.json() : undefined };
}

/** Every show tomorrow, as { id, availableSeats }, most free seats first. */
export function showsTomorrow(ip) {
  const date = tomorrowInIndia();
  const { body } = getJson(`/api/v1/cities/${CITY}/movies?date=${date}`, ip);
  if (!body) throw new Error('could not list movies; is the stack seeded? (make stack-seed)');
  const shows = [];
  for (const movie of body.movies) {
    const { body: listing } = getJson(
      `/api/v1/movies/${movie.id}/shows?city=${CITY}&date=${date}`,
      ip,
    );
    for (const theatre of listing.theatres) shows.push(...theatre.shows);
  }
  return shows.sort((a, b) => b.availableSeats - a.availableSeats);
}

/**
 * Signs up `count` new buyers, `batch` at a time, each from its own address (sign-up is limited to
 * 5 a minute per IP). Returns each buyer's session cookie value.
 */
export function signUpBuyers(count, { batch = 20, firstIp = 1_000_000 } = {}) {
  const cookies = [];
  for (let start = 0; start < count; start += batch) {
    const requests = [];
    for (let i = start; i < Math.min(count, start + batch); i++) {
      const id = `${Date.now()}-${i}-${Math.floor(Math.random() * 1e9)}`;
      requests.push([
        'POST',
        `${BASE_URL}/api/auth/sign-up/email`,
        JSON.stringify({
          name: `Load Buyer ${i}`,
          email: `load-${id}@example.test`,
          password: `pw-${id}`,
        }),
        {
          headers: headersFor(visitorIp(firstIp + i), {
            'Content-Type': 'application/json',
            Origin: ORIGIN,
          }),
          tags: { name: 'sign-up (setup)' },
        },
      ]);
    }
    for (const res of http.batch(requests)) {
      const cookie = res.cookies[SESSION_COOKIE]?.[0]?.value;
      if (res.status !== 200 || !cookie) {
        throw new Error(`sign-up failed: ${res.status} ${String(res.body).slice(0, 200)}`);
      }
      cookies.push(cookie);
    }
  }
  return cookies;
}
