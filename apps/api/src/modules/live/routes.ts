import type { Pool } from '@bmt/platform';
import { Router } from 'express';
import { AppError, NotFoundError } from '../../lib/errors';
import { NO_LIMITS, type RouteLimits } from '../../lib/rate-limit';
import { parseParams } from '../../lib/validate';
import { idParam } from '../catalog/schemas';
import type { SeatEventHub, SeatStream } from './hub';
import { createStreamLimiter } from './stream-limits';

/** Enough for a few tabs, or a family on one home network. */
export const DEFAULT_STREAMS_PER_IP = 6;

/** Browsers wait this long before reconnecting after the stream drops. */
const RETRY_MS = 3_000;

/**
 * GET /api/v1/shows/:id/seats/events: the show's seat changes as Server-Sent Events (ADR 0013).
 *
 * The browser opens the stream, waits for `ready`, then loads GET /shows/:id/seats and merges
 * every `seats` event into it, keeping the higher version of each seat. After a reconnect or a
 * `resync` it loads the map again. Public, like the seat map.
 */
export function liveRouter(deps: {
  pool: Pool;
  seatEventHub?: SeatEventHub;
  seatStreamsPerIp?: number;
  limits?: RouteLimits;
}): Router {
  const router = Router();
  const limiter = createStreamLimiter(deps.seatStreamsPerIp ?? DEFAULT_STREAMS_PER_IP);
  const browse = (deps.limits ?? NO_LIMITS).browse;

  router.get('/shows/:id/seats/events', browse, async (req, res) => {
    const hub = deps.seatEventHub;
    if (!hub) {
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Live seat updates are not available');
    }
    const { id: showId } = parseParams(idParam, req);
    const { rowCount } = await deps.pool.query('SELECT 1 FROM shows WHERE id = $1', [showId]);
    if (rowCount === 0) throw new NotFoundError('Show not found');

    const ip = req.ip ?? 'unknown';
    if (!limiter.tryAcquire(ip)) {
      res.set('Retry-After', '30');
      throw new AppError(429, 'RATE_LIMITED', 'Too many live seat maps are open from your network');
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform keeps compressing proxies (Next.js in development) from buffering events.
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx would otherwise buffer the response and deliver events in clumps.
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: ${RETRY_MS}\n\n`);

    const stream: SeatStream = {
      send(event, data) {
        res.write(`event: ${event}\ndata: ${data}\n\n`);
      },
      end() {
        res.end();
      },
    };

    let stop: (() => void) | undefined;
    let closed = false;
    req.on('close', () => {
      closed = true;
      stop?.();
      limiter.release(ip);
    });

    try {
      stop = await hub.watch(showId, stream);
    } catch (err) {
      req.log.warn({ err, showId }, 'could not subscribe to seat events');
      res.end();
      return;
    }
    // The browser may have gone while the subscription was being set up.
    if (closed) stop();
    else stream.send('ready', '{}');
  });

  return router;
}
