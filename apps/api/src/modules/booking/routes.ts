import type { HoldExpiryScheduler } from '@bmt/jobs';
import { loadBookingDetails, renderTicketPdf, ticketFilename } from '@bmt/jobs';
import type { Logger, Pool, Redis } from '@bmt/platform';
import { Router } from 'express';
import { AppError } from '../../lib/errors';
import { hashRequest, idempotent } from '../../lib/idempotency';
import { parseBody, parseParams } from '../../lib/validate';
import type { Auth } from '../auth/auth';
import { requireAuth } from '../auth/middleware';
import { bookingIdParam, createHoldSchema } from './schemas';
import { createBookingService, DEFAULT_BOOKING_CONFIG, type BookingConfig } from './service';
import { createStrategy } from './strategies';

/** Bookings for the signed-in user. Mounted at /api/v1. */
export function bookingRouter(deps: {
  pool: Pool;
  redis: Redis;
  logger: Logger;
  auth: Auth;
  booking?: BookingConfig;
  holdExpiry?: HoldExpiryScheduler;
}): Router {
  const config = deps.booking ?? DEFAULT_BOOKING_CONFIG;
  const bookings = createBookingService(
    deps.pool,
    config,
    createStrategy(config.strategy, deps),
    deps.holdExpiry,
  );
  const holdSchema = createHoldSchema(config.maxSeatsPerBooking);
  const router = Router();
  const signedIn = requireAuth(deps.auth);

  /**
   * Hold seats. Requires an Idempotency-Key header: a retry with the same key
   * returns the first response (with Idempotent-Replayed: true) instead of
   * creating a second booking.
   */
  router.post('/bookings', signedIn, async (req, res) => {
    const key = req.get('Idempotency-Key')?.trim();
    if (!key || key.length > 255) {
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        'An Idempotency-Key header (1 to 255 characters) is required',
      );
    }
    const input = parseBody(holdSchema, req);
    const userId = req.auth!.user.id;

    const result = await idempotent(
      deps.pool,
      {
        userId,
        key,
        requestHash: hashRequest({
          route: 'POST /bookings',
          showId: input.showId,
          seatIds: [...input.seatIds].sort(),
        }),
      },
      async () => ({ status: 201, body: { booking: await bookings.hold(userId, input) } }),
    );

    if (result.replayed) res.set('Idempotent-Replayed', 'true');
    res.status(result.status).json(result.body);
  });

  router.get('/bookings/:id', signedIn, async (req, res) => {
    const { id } = parseParams(bookingIdParam, req);
    res.json({ booking: await bookings.get(req.auth!.user.id, id) });
  });

  /** The ticket as a PDF, rendered from the booking. Only for the owner of a confirmed booking. */
  router.get('/bookings/:id/ticket', signedIn, async (req, res) => {
    const { id } = parseParams(bookingIdParam, req);
    const booking = await bookings.get(req.auth!.user.id, id); // 404 for anyone else's
    if (booking.status !== 'CONFIRMED') {
      throw new AppError(
        409,
        'BOOKING_NOT_CONFIRMED',
        'A ticket exists only for a confirmed booking',
      );
    }
    const details = (await loadBookingDetails(deps.pool, id))!;
    const pdf = await renderTicketPdf(details);
    res
      .type('application/pdf')
      .set('Content-Disposition', `attachment; filename="${ticketFilename(id)}"`)
      .set('Cache-Control', 'private, no-store')
      .send(pdf);
  });

  router.delete('/bookings/:id/hold', signedIn, async (req, res) => {
    const { id } = parseParams(bookingIdParam, req);
    res.json({ booking: await bookings.release(req.auth!.user.id, id) });
  });

  return router;
}
