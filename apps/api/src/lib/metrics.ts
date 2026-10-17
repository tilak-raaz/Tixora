import {
  Counter,
  createMetricsRegistry,
  Gauge,
  Histogram,
  renderMetrics,
  type Pool,
  type Registry,
} from '@bmt/platform';
import type { Request, RequestHandler } from 'express';

/**
 * The API's metrics (ADR 0015). Each replica serves its own at GET /metrics, at the root and
 * outside /api, so nginx never routes it: only containers on the stack's network can read it.
 */

/** How a hold attempt ended. */
export const HOLD_OUTCOMES = ['held', 'rejected_early', 'seats_taken', 'refused', 'error'] as const;
export type HoldOutcome = (typeof HOLD_OUTCOMES)[number];

export interface ApiMetrics {
  registry: Registry;
  /** Times every request except health checks, /metrics and seat streams. */
  http: RequestHandler;
  /** GET /metrics */
  handler: RequestHandler;
  holdOutcome(outcome: HoldOutcome): void;
}

export interface ApiMetricsDeps {
  pool: Pool;
  /** Open seat streams on this replica (ADR 0013). */
  seatStreams?: () => { shows: number; streams: number };
  instance?: string;
}

const NOT_TIMED = new Set(['/healthz', '/readyz', '/metrics']);
/** Seat streams stay open for minutes; their "duration" would drown every other number. */
const SEAT_STREAM = /^\/api\/v1\/shows\/[^/]+\/seats\/events$/;
/** Better Auth answers everything under /api/auth with one handler; these are the ones we use. */
const AUTH_PATHS = new Set([
  '/api/auth/sign-up/email',
  '/api/auth/sign-in/email',
  '/api/auth/sign-out',
  '/api/auth/get-session',
]);

/**
 * The route label: the route's pattern with its mount prefix, such as /api/v1/bookings/:id. One
 * route is one series whatever the id, and paths that matched nothing share `unmatched`, so a
 * scanner trying random URLs cannot create series without end.
 *
 * Express clears req.baseUrl when a handler throws, but keeps req.route, so the prefix is taken
 * from the request's own path: whatever comes before the route pattern's segments. Mount points
 * are fixed strings (/api/v1, /admin), never ids.
 */
export function routeLabel(req: Pick<Request, 'originalUrl' | 'route'>): string {
  const path = req.originalUrl.split('?')[0]!.replace(/\/+$/, '') || '/';
  if (path.startsWith('/api/auth/')) return AUTH_PATHS.has(path) ? path : '/api/auth/other';
  const pattern: unknown = req.route?.path;
  if (typeof pattern !== 'string') return 'unmatched';
  const segments = path.split('/').filter(Boolean);
  const patternSegments = pattern.split('/').filter(Boolean);
  const prefix = segments.slice(0, Math.max(0, segments.length - patternSegments.length));
  return `/${[...prefix, ...patternSegments].join('/')}`;
}

export function createApiMetrics(deps: ApiMetricsDeps): ApiMetrics {
  const registry = createMetricsRegistry({
    service: 'api',
    pool: deps.pool,
    ...(deps.instance ? { instance: deps.instance } : {}),
  });

  const duration = new Histogram({
    name: 'bmt_http_request_duration_seconds',
    help: 'Time from request to response, by method, route and status',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  const holds = new Counter({
    name: 'bmt_holds_total',
    help:
      'Hold attempts by outcome: held; rejected_early (the Redis pre-lock turned it away); ' +
      'seats_taken (Postgres found a seat taken); refused (another 4xx); error (5xx)',
    labelNames: ['outcome'] as const,
    registers: [registry],
  });
  // Every outcome appears from the start, so a rate over a load run never starts from a gap.
  for (const outcome of HOLD_OUTCOMES) holds.inc({ outcome }, 0);

  const seatStreams = deps.seatStreams;
  if (seatStreams) {
    new Gauge({
      name: 'bmt_seat_streams',
      help: 'Seat streams open on this replica',
      registers: [registry],
      collect() {
        this.set(seatStreams().streams);
      },
    });
    new Gauge({
      name: 'bmt_seat_stream_shows',
      help: 'Shows this replica holds a Redis subscription for (one per show, however many viewers)',
      registers: [registry],
      collect() {
        this.set(seatStreams().shows);
      },
    });
  }

  return {
    registry,
    http(req, res, next) {
      if (NOT_TIMED.has(req.path) || SEAT_STREAM.test(req.path)) return next();
      const end = duration.startTimer();
      res.on('finish', () => {
        end({ method: req.method, route: routeLabel(req), status: String(res.statusCode) });
      });
      next();
    },
    async handler(_req, res) {
      const { contentType, body } = await renderMetrics(registry);
      res.set('Content-Type', contentType).send(body);
    },
    holdOutcome(outcome) {
      holds.inc({ outcome });
    },
  };
}
