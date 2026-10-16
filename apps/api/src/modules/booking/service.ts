import type { HoldExpiryScheduler } from '@bmt/jobs';
import { NO_SEAT_EVENTS, withTransaction, type Pool, type SeatEventPublisher } from '@bmt/platform';
import { AppError, NotFoundError } from '../../lib/errors';
import { isPgError, PG_UNIQUE_VIOLATION } from '../../lib/pg-errors';
import * as repo from './repo';
import type { HoldInput } from './schemas';
import { conditionalStrategy, type HoldStrategyName, type SeatHoldStrategy } from './strategies';

export interface BookingConfig {
  /** How long held seats stay reserved for payment. */
  holdTtlSeconds: number;
  maxSeatsPerBooking: number;
  /** How seats are taken (ADR 0005). */
  strategy: HoldStrategyName;
}

export const DEFAULT_BOOKING_CONFIG: BookingConfig = {
  holdTtlSeconds: 5 * 60,
  maxSeatsPerBooking: 5,
  // Chosen from measurement, not instinct: see ADR 0005 and docs/benchmarks.
  strategy: 'redis',
};

export type BookingService = ReturnType<typeof createBookingService>;

/**
 * `strategy` defaults to plain `conditional`, which needs no Redis client
 * (handy in tests); the app passes the configured one (`redis` by default).
 * `expiry` queues the job that releases a hold when it runs out; without it
 * (tests, the benchmark) the worker's sweeper still releases it.
 * `seatEvents` tells everyone watching the show which seats changed (ADR 0013).
 */
export function createBookingService(
  pool: Pool,
  config: BookingConfig = DEFAULT_BOOKING_CONFIG,
  strategy: SeatHoldStrategy = conditionalStrategy,
  expiry?: HoldExpiryScheduler,
  seatEvents: SeatEventPublisher = NO_SEAT_EVENTS,
) {
  /** The hold transaction: everything except the optional pre-lock. */
  async function holdInDatabase(
    userId: string,
    input: HoldInput,
  ): Promise<{ id: string; expiresAt: Date; expiredIds: string[] }> {
    return withTransaction(pool, async (tx) => {
      const show = await repo.findShowForHold(tx, input.showId);
      if (!show) throw new NotFoundError('Show not found');
      if (!show.bookable) {
        throw new AppError(400, 'VALIDATION_FAILED', 'This show is no longer open for booking');
      }

      const expiredIds = await repo.expireStaleHold(tx, userId, input.showId);

      const seats = await repo.findSeatPrices(tx, input.showId, input.seatIds);
      if (seats.length !== input.seatIds.length) {
        const known = new Set(seats.map((s) => s.id));
        throw new AppError(400, 'VALIDATION_FAILED', 'Some seats are not part of this show', {
          unknownSeatIds: input.seatIds.filter((id) => !known.has(id)),
        });
      }

      let booking: { id: string; expiresAt: Date };
      try {
        booking = await repo.insertBooking(tx, {
          userId,
          showId: input.showId,
          totalPaise: seats.reduce((sum, s) => sum + s.price_paise, 0),
          holdTtlSeconds: config.holdTtlSeconds,
        });
      } catch (err) {
        if (isPgError(err) && err.code === PG_UNIQUE_VIOLATION) {
          throw new AppError(
            409,
            'ACTIVE_HOLD_EXISTS',
            'You already have seats on hold for this show; pay for them or release them first',
          );
        }
        throw err;
      }

      const held = await strategy.takeSeats(tx, {
        bookingId: booking.id,
        showId: input.showId,
        showSeatIds: input.seatIds,
        heldUntil: booking.expiresAt,
      });
      if (held.length !== input.seatIds.length) {
        // Throwing rolls back the booking and any seats this attempt did take.
        throw seatsUnavailable(input.seatIds, held);
      }

      await repo.insertBookingSeats(tx, booking.id, seats);
      return { ...booking, expiredIds };
    });
  }

  return {
    strategy: strategy.name,

    /**
     * Holds seats for the user for `holdTtlSeconds`: all of them, or none.
     * Everything happens in one short transaction, so a failure at any step
     * (seat taken, second pending booking) leaves no trace.
     */
    async hold(userId: string, input: HoldInput): Promise<repo.BookingView> {
      let booking: { id: string; expiresAt: Date; expiredIds: string[] };
      if (strategy.preLock) {
        const lock = await strategy.preLock({ showId: input.showId, showSeatIds: input.seatIds });
        if (!lock.ok) {
          throw seatsUnavailable(
            input.seatIds,
            input.seatIds.filter((id) => !lock.takenSeatIds.includes(id)),
          );
        }
        try {
          booking = await holdInDatabase(userId, input);
        } finally {
          await lock.release();
        }
      } else {
        booking = await holdInDatabase(userId, input);
      }
      // Only after the commit: a job or an event for a hold that rolled back would be noise.
      await Promise.all([
        expiry?.schedule(booking.id, booking.expiresAt),
        seatEvents.publishBookings([booking.id, ...booking.expiredIds]),
      ]);
      return (await repo.findBookingView(pool, booking.id, userId))!;
    },

    /** The user's latest bookings, newest first. */
    list(userId: string, limit = 50): Promise<repo.BookingSummary[]> {
      return repo.listBookings(pool, userId, limit);
    },

    async get(userId: string, bookingId: string): Promise<repo.BookingView> {
      const booking = await repo.findBookingView(pool, bookingId, userId);
      // Someone else's booking is "not found", so ids cannot be probed.
      if (!booking) throw new NotFoundError('Booking not found');
      return booking;
    },

    /** Releases an active hold: the booking becomes CANCELLED and its seats free. */
    async release(userId: string, bookingId: string): Promise<repo.BookingView> {
      await withTransaction(pool, async (tx) => {
        if (await repo.cancelHold(tx, bookingId, userId)) {
          await repo.releaseSeats(tx, bookingId);
          return;
        }
        if (!(await repo.findBookingView(tx, bookingId, userId))) {
          throw new NotFoundError('Booking not found');
        }
        throw new AppError(409, 'HOLD_NOT_ACTIVE', 'Only an active hold can be released');
      });
      await seatEvents.publishBookings([bookingId]);
      return (await repo.findBookingView(pool, bookingId, userId))!;
    },
  };
}

function seatsUnavailable(requested: string[], taken: string[]): AppError {
  const got = new Set(taken);
  return new AppError(409, 'SEATS_UNAVAILABLE', 'Some of these seats were just taken', {
    unavailableSeatIds: requested.filter((id) => !got.has(id)),
  });
}
