import type { Logger } from 'pino';
import type { Pool, PoolClient } from './db';
import type { Redis } from './redis';

/**
 * Live seat updates (ADR 0013). After any change to seats commits (a hold, a release, an expiry,
 * a confirmed payment), the process that made it publishes the seats' new public state on the
 * show's Redis channel. Every API replica subscribes to the channels of the shows its browsers
 * are watching and forwards each message to them over Server-Sent Events.
 *
 * These messages are hints, not the source of truth: a lost one only leaves a seat map stale for a
 * moment, and the heartbeat's seat version catches that (see the SSE hub in the API). Who gets a
 * seat is still decided by the hold transaction alone.
 */

type Db = Pool | PoolClient;

/**
 * Whether a show seat counts as free: available, or held by a hold whose time is up (its seats are
 * free the moment it runs out, before the expiry job tidies the row). Shared by the seat map and
 * the events, so both always agree. Expects the alias `ss` for show_seats.
 */
export const SEAT_IS_FREE = `(ss.status = 'AVAILABLE' OR (ss.status = 'HELD' AND ss.held_until <= now()))`;

/** What everyone may know about a seat: free or not. Who holds it, and why, stays private. */
export type PublicSeatStatus = 'AVAILABLE' | 'UNAVAILABLE';

export interface SeatState {
  id: string;
  status: PublicSeatStatus;
  /** show_seats.version: grows on every change, so a client keeps the higher one. */
  version: number;
}

export interface SeatEvent {
  showId: string;
  seats: SeatState[];
}

export function seatEventChannel(showId: string): string {
  return `bmt:seats:${showId}`;
}

/** The show id in a channel name, or undefined for any other channel. */
export function showIdFromChannel(channel: string): string | undefined {
  return channel.startsWith('bmt:seats:') ? channel.slice('bmt:seats:'.length) : undefined;
}

export interface SeatEventPublisher {
  /**
   * Publishes the current state of every seat of these bookings. Call it after the change has
   * committed. It reads the state back rather than trusting the caller, so whatever it sends is
   * true at that moment. Never throws: the change is already done, and a lost event is caught by
   * the heartbeat.
   */
  publishBookings(bookingIds: readonly string[]): Promise<void>;
}

/** For tests and scripts that do not need live updates. */
export const NO_SEAT_EVENTS: SeatEventPublisher = {
  async publishBookings() {},
};

export function createSeatEventPublisher(
  deps: { pool: Db; redis: Redis; logger: Logger },
  opts: { timeoutMs?: number } = {},
): SeatEventPublisher {
  const timeoutMs = opts.timeoutMs ?? 500;

  async function publish(bookingIds: readonly string[]): Promise<void> {
    const { rows } = await deps.pool.query<SeatState & { showId: string }>(
      `SELECT ss.show_id AS "showId", ss.id,
              CASE WHEN ${SEAT_IS_FREE} THEN 'AVAILABLE' ELSE 'UNAVAILABLE' END AS status,
              ss.version
       FROM booking_seats bs
       JOIN show_seats ss ON ss.id = bs.show_seat_id
       WHERE bs.booking_id = ANY($1::uuid[])`,
      [bookingIds],
    );

    const byShow = new Map<string, SeatState[]>();
    for (const { showId, id, status, version } of rows) {
      const seats = byShow.get(showId) ?? [];
      seats.push({ id, status, version });
      byShow.set(showId, seats);
    }
    await Promise.all(
      [...byShow].map(([showId, seats]) =>
        deps.redis.publish(seatEventChannel(showId), JSON.stringify({ showId, seats })),
      ),
    );
  }

  return {
    async publishBookings(bookingIds) {
      if (bookingIds.length === 0) return;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          publish(bookingIds),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`timed out after ${timeoutMs} ms`)),
              timeoutMs,
            );
          }),
        ]);
      } catch (err) {
        deps.logger.warn(
          { err, bookingIds },
          'could not publish seat changes; the heartbeat will catch up',
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
