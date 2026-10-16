import type { Logger, Pool } from '@bmt/platform';
import type { PaymentGateway } from '@bmt/payments';
import { Router, type RequestHandler } from 'express';
import { AppError } from '../../lib/errors';
import { NO_LIMITS, type RouteLimits } from '../../lib/rate-limit';
import { parseBody, parseParams } from '../../lib/validate';
import type { Auth } from '../auth/auth';
import { requireAuth } from '../auth/middleware';
import { bookingIdParam } from '../booking/schemas';
import { verifyCheckoutSchema } from './schemas';
import { createPaymentService, type PaymentConfig } from './service';

/** Paying for a held booking. Mounted at /api/v1. */
export function paymentRouter(deps: {
  pool: Pool;
  logger: Logger;
  auth: Auth;
  paymentGateway?: PaymentGateway;
  payment?: Partial<PaymentConfig>;
  limits?: RouteLimits;
}): Router {
  const payments = deps.paymentGateway
    ? createPaymentService(deps.pool, deps.paymentGateway, deps.logger, deps.payment)
    : undefined;
  const router = Router();
  const signedIn = requireAuth(deps.auth);
  const configured: RequestHandler = (_req, _res, next) => {
    if (!payments) {
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Payments are not configured on this server');
    }
    next();
  };

  /** The booking's Razorpay order: 201 when this call created it, 200 when it already existed. */
  const limited = (deps.limits ?? NO_LIMITS).paymentOrder;

  router.post('/bookings/:id/payment-order', signedIn, limited, configured, async (req, res) => {
    const { id } = parseParams(bookingIdParam, req);
    const { order, created } = await payments!.createOrder(req.auth!.user.id, id);
    res.status(created ? 201 : 200).json({ order });
  });

  /** Checkout's success callback, checked. The booking stays as it is until the webhook. */
  router.post('/bookings/:id/payment/verify', signedIn, configured, async (req, res) => {
    const { id } = parseParams(bookingIdParam, req);
    const input = parseBody(verifyCheckoutSchema, req);
    res.json(await payments!.verifyCheckout(req.auth!.user.id, id, input));
  });

  return router;
}
