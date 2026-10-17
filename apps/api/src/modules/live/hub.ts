import {
  seatEventChannel,
  showIdFromChannel,
  type Logger,
  type Pool,
  type Redis,
} from '@bmt/platform';

/**
 * Live seat maps, one hub per API replica (ADR 0013).
 *
 * - One Redis subscription per show that has viewers on this replica, not one per viewer. The
 *   last viewer leaving unsubscribes.
 * - Every message on a show's channel goes to each of its viewers as an `seats` event, whichever
 *   replica or worker published it.
 * - Every `heartbeatMs` each viewer gets a `heartbeat` with the show's seat version (the sum of
 *   its seats' versions). It keeps proxies from closing an idle connection, and lets the browser
 *   notice an event it never received: the sum moved past what its own seats add up to.
 * - When the subscription itself drops and comes back, messages may have been missed in between,
 *   so every viewer gets `resync` and reloads the seat map.
 */

/** One open event stream; the route adapts an HTTP response to this. */
export interface SeatStream {
  send(event: 'ready' | 'seats' | 'heartbeat' | 'resync', data: string): void;
  end(): void;
}

export interface SeatEventHub {
  /** Starts sending a show's events to `stream` once subscribed. Returns the function that stops. */
  watch(showId: string, stream: SeatStream): Promise<() => void>;
  stats(): { shows: number; streams: number };
  /** True once close() has started: new viewers should be sent to another replica. */
  readonly closing: boolean;
  /** Ends every stream (browsers reconnect elsewhere) and closes the subscription. */
  close(): Promise<void>;
}

export interface SeatEventHubOptions {
  heartbeatMs?: number;
}

export const DEFAULT_HEARTBEAT_MS = 15_000;

export function createSeatEventHub(
  deps: { pool: Pool; redis: Redis; logger: Logger },
  opts: SeatEventHubOptions = {},
): SeatEventHub {
  const logger = deps.logger.child({ module: 'seat-events' });
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  // A connection in subscriber mode cannot run other commands, so the hub has its own.
  const subscriber = deps.redis.duplicate();
  subscriber.on('error', (err) => logger.warn({ err }, 'seat event subscriber error'));

  const viewers = new Map<string, Set<SeatStream>>();
  const subscriptions = new Map<string, Promise<unknown>>();
  let closing = false;

  function broadcast(showId: string, event: Parameters<SeatStream['send']>[0], data: string) {
    for (const stream of viewers.get(showId) ?? []) {
      try {
        stream.send(event, data);
      } catch (err) {
        logger.debug({ err, showId }, 'could not write to a seat stream');
      }
    }
  }

  subscriber.on('message', (channel: string, message: string) => {
    const showId = showIdFromChannel(channel);
    if (showId) broadcast(showId, 'seats', message);
  });

  // ioredis subscribes again by itself after a reconnect, but anything published while the
  // connection was down is gone, so every viewer reloads its map.
  let connectedBefore = false;
  subscriber.on('ready', () => {
    if (connectedBefore) {
      logger.warn(
        { shows: viewers.size },
        'seat event subscriber reconnected; asking viewers to resync',
      );
      for (const showId of viewers.keys()) broadcast(showId, 'resync', '{}');
    }
    connectedBefore = true;
  });

  async function heartbeat(): Promise<void> {
    const showIds = [...viewers.keys()];
    if (showIds.length === 0) return;
    let versions = new Map<string, number>();
    try {
      const { rows } = await deps.pool.query<{ showId: string; version: string }>(
        `SELECT show_id AS "showId", sum(version)::bigint AS version
         FROM show_seats WHERE show_id = ANY($1::uuid[]) GROUP BY show_id`,
        [showIds],
      );
      versions = new Map(rows.map((r) => [r.showId, Number(r.version)]));
    } catch (err) {
      // Still send the heartbeat: without a version it only keeps the connection open.
      logger.warn({ err }, 'could not read seat versions for the heartbeat');
    }
    for (const showId of showIds) {
      const seatsVersion = versions.get(showId);
      broadcast(
        showId,
        'heartbeat',
        JSON.stringify(seatsVersion === undefined ? {} : { seatsVersion }),
      );
    }
  }

  const timer = setInterval(() => void heartbeat(), heartbeatMs);
  timer.unref();

  function stopWatching(showId: string, stream: SeatStream) {
    const streams = viewers.get(showId);
    if (!streams?.delete(stream) || streams.size > 0) return;
    viewers.delete(showId);
    subscriptions.delete(showId);
    subscriber.unsubscribe(seatEventChannel(showId)).catch((err: unknown) => {
      logger.warn({ err, showId }, 'could not unsubscribe from seat events');
    });
  }

  return {
    async watch(showId, stream) {
      let streams = viewers.get(showId);
      if (!streams) {
        streams = new Set();
        viewers.set(showId, streams);
        subscriptions.set(showId, subscriber.subscribe(seatEventChannel(showId)));
      }
      streams.add(stream);
      // A second viewer of the same show waits for the first one's subscription too, so neither
      // is told it is ready before events can actually reach it.
      try {
        await subscriptions.get(showId);
      } catch (err) {
        stopWatching(showId, stream);
        throw err;
      }
      return () => stopWatching(showId, stream);
    },

    get closing() {
      return closing;
    },

    stats() {
      let streams = 0;
      for (const set of viewers.values()) streams += set.size;
      return { shows: viewers.size, streams };
    },

    async close() {
      closing = true;
      clearInterval(timer);
      for (const streams of viewers.values()) {
        for (const stream of streams) stream.end();
      }
      viewers.clear();
      subscriptions.clear();
      await subscriber.quit().catch(() => undefined);
    },
  };
}
