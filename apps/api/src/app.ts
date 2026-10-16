import type { HoldExpiryScheduler } from '@bmt/jobs';
import type { FakeGateway, PaymentGateway } from '@bmt/payments';
import type { Logger, Pool, Redis, SeatEventPublisher } from '@bmt/platform';
import { toNodeHandler } from 'better-auth/node';
import express, { Router, type Express } from 'express';
import type { Cache } from './lib/cache';
import {
  createRateLimiter,
  NO_LIMITS,
  routeLimits,
  type RateLimiter,
  type RateLimitPolicies,
} from './lib/rate-limit';
import { errorHandler } from './middleware/error-handler';
import { notFoundHandler } from './middleware/not-found';
import { requestLogger } from './middleware/request-logger';
import type { Auth } from './modules/auth/auth';
import { authRouter } from './modules/auth/routes';
import { bookingRouter } from './modules/booking/routes';
import type { BookingConfig } from './modules/booking/service';
import { adminCatalogRouter, catalogRouter } from './modules/catalog/routes';
import type { SeatEventHub } from './modules/live/hub';
import { liveRouter } from './modules/live/routes';
import { fakeCheckoutRouter } from './modules/payment/fake-checkout';
import { paymentRouter } from './modules/payment/routes';
import type { PaymentConfig } from './modules/payment/service';
import { razorpayWebhookRouter } from './modules/payment/webhook';
import { healthRouter } from './routes/health';

export interface AppDeps {
  logger: Logger;
  pool: Pool;
  redis: Redis;
  auth: Auth;
  /** Hold length and seat limit; defaults to 5 minutes and 5 seats. */
  booking?: BookingConfig;
  /** Queues each hold's expiry job; without it the worker's sweeper still releases holds. */
  holdExpiry?: HoldExpiryScheduler;
  /** Razorpay (or the fake in tests); without it the payment endpoints answer 503. */
  paymentGateway?: PaymentGateway;
  payment?: Partial<PaymentConfig>;
  /** Verifies Razorpay webhooks; without it /webhooks/razorpay answers 503. */
  paymentWebhookSecret?: string;
  /**
   * PAYMENT_GATEWAY=fake: payments without Razorpay, for development and the end-to-end tests.
   * Also pass it as paymentGateway; it mounts POST /api/v1/dev/fake-payments/:id.
   */
  fakePayments?: { gateway: FakeGateway; webhookDelayMs?: number };
  /**
   * Rate limits per route class (ADR 0010). Off when absent, as in most tests;
   * the limiter defaults to one on `redis`.
   */
  rateLimits?: { policies: RateLimitPolicies; limiter?: RateLimiter };
  /** Catalog read cache; without it every read goes to Postgres (most tests). */
  cache?: Cache;
  /** Announces seat changes for live seat maps (ADR 0013); without it nothing is announced. */
  seatEvents?: SeatEventPublisher;
  /** Serves GET /shows/:id/seats/events; without it that endpoint answers 503. */
  seatEventHub?: SeatEventHub;
  /** Live seat maps one address may keep open on this replica (default 6). */
  seatStreamsPerIp?: number;
}

/**
 * Builds the Express app without listening, so tests can drive it with
 * supertest and server.ts owns the network and process lifecycle.
 */
export function createApp(deps: AppDeps): Express {
  const app = express();

  app.disable('x-powered-by');
  // One proxy hop (nginx) in front of the replicas from M7; keeps req.ip correct.
  app.set('trust proxy', 1);

  app.use(requestLogger(deps.logger));

  const limits = deps.rateLimits
    ? routeLimits(
        deps.rateLimits.limiter ?? createRateLimiter(deps.redis),
        deps.rateLimits.policies,
        deps.logger,
      )
    : NO_LIMITS;
  const routerDeps = { ...deps, limits };

  // Password guessing is limited per IP before Better Auth sees the request.
  app.post(['/api/auth/sign-in/email', '/api/auth/sign-up/email'], limits.auth);

  // Better Auth's endpoints (sign-up, sign-in, sign-out, get-session).
  // Mounted before express.json() because Better Auth reads the raw body itself.
  app.all('/api/auth/*splat', toNodeHandler(deps.auth));

  // Razorpay webhooks need the raw body to check its signature, so they also
  // come before express.json().
  // Never rate limited: Razorpay retries, and every event is deduplicated anyway.
  app.use(razorpayWebhookRouter(deps));

  app.use(express.json({ limit: '100kb' }));

  // Ops endpoints live at the root, outside the versioned API.
  app.use(healthRouter(deps));

  const v1 = Router();
  v1.use(authRouter(deps));
  v1.use(catalogRouter(routerDeps));
  v1.use(liveRouter(routerDeps));
  v1.use(bookingRouter(routerDeps));
  v1.use(paymentRouter(routerDeps));
  v1.use('/admin', adminCatalogRouter(routerDeps));
  if (deps.fakePayments && deps.paymentWebhookSecret) {
    v1.use(
      '/dev',
      fakeCheckoutRouter({
        ...deps,
        fakeGateway: deps.fakePayments.gateway,
        paymentWebhookSecret: deps.paymentWebhookSecret,
        webhookDelayMs: deps.fakePayments.webhookDelayMs,
      }),
    );
  }
  app.use('/api/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
