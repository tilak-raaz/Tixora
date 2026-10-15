import type { Pool } from '@bmt/platform';
import { Router } from 'express';
import { AppError } from '../../lib/errors';
import { hashRequest, idempotent } from '../../lib/idempotency';
import { parseBody, parseParams } from '../../lib/validate';
import type { Auth } from '../auth/auth';
import { requireAuth } from '../auth/middleware';
import { bookingIdParam, createHoldSchema } from './schemas';
import { createBookingService, DEFAULT_BOOKING_CONFIG, type BookingConfig } from './service';

/** Bookings for the signed-in user. Mounted at /api/v1. */
export function bookingRouter(deps: { pool: Pool; auth: Auth; booking?: BookingConfig }): Router {
  const config = deps.booking ?? DEFAULT_BOOKING_CONFIG;
  const bookings = createBookingService(deps.pool, config);
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

  router.delete('/bookings/:id/hold', signedIn, async (req, res) => {
    const { id } = parseParams(bookingIdParam, req);
    res.json({ booking: await bookings.release(req.auth!.user.id, id) });
  });

  return router;
}
