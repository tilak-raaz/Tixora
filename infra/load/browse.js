// Browse load (ADR 0016): visitors go home page -> a movie -> its shows -> a show -> its seat map,
// about a second apart, ramping up to VUS at once. Each visit comes from a new address, as many
// separate people would, so the per-IP browse limit applies to each of them and not to k6.
//
//   make load-browse VUS=100            people browsing: about a second between clicks
//   make load-browse VUS=50 THINK=0     capacity: no pauses, as many requests as the stack takes
import { check, sleep } from 'k6';
import { getJson, CITY, tomorrowInIndia, visitorIp } from './lib.js';

const VUS = Number(__ENV.VUS || 100);
/** Pause between clicks in seconds; unset means 0.3 to 0.7 s, like a person; 0 means none. */
const THINK = __ENV.THINK === undefined ? undefined : Number(__ENV.THINK);

export const options = {
  scenarios: {
    browse: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: Math.ceil(VUS / 4) },
        { duration: '40s', target: VUS },
        { duration: '60s', target: VUS },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:seat map}': ['p(95)<500'],
    http_req_duration: ['p(95)<500'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const think = () => {
  const seconds = THINK ?? 0.3 + Math.random() * 0.4;
  if (seconds > 0) sleep(seconds);
};

export default function () {
  const ip = visitorIp(__VU * 100_000 + __ITER);
  const date = tomorrowInIndia();

  const cities = getJson('/api/v1/cities', ip, { tags: { name: 'cities' } });
  check(cities.res, { 'cities 200': (r) => r.status === 200 });
  think();

  const movies = getJson(`/api/v1/cities/${CITY}/movies?date=${date}`, ip, {
    tags: { name: 'movies in city' },
  });
  if (!check(movies.res, { 'movies 200': (r) => r.status === 200 }) || !movies.body.movies.length)
    return;
  const movie = pick(movies.body.movies);
  think();

  getJson(`/api/v1/movies/${movie.id}`, ip, { tags: { name: 'movie' } });
  const shows = getJson(`/api/v1/movies/${movie.id}/shows?city=${CITY}&date=${date}`, ip, {
    tags: { name: 'shows of movie' },
  });
  if (!check(shows.res, { 'shows 200': (r) => r.status === 200 })) return;
  const all = shows.body.theatres.flatMap((t) => t.shows);
  if (!all.length) return;
  const show = pick(all);
  think();

  getJson(`/api/v1/shows/${show.id}`, ip, { tags: { name: 'show' } });
  const seats = getJson(`/api/v1/shows/${show.id}/seats`, ip, { tags: { name: 'seat map' } });
  check(seats.res, { 'seat map 200': (r) => r.status === 200 });
  think();
}
