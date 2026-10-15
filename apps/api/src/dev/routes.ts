import { readFileSync } from 'node:fs';
import { Router } from 'express';

const CHECKOUT_PAGE = readFileSync(new URL('./checkout.html', import.meta.url), 'utf8');

/**
 * Pages for trying the API by hand in development: GET /dev/checkout holds
 * seats and pays in Razorpay test mode until the real frontend exists (M6).
 * Never mounted outside development.
 */
export function devRouter(): Router {
  const router = Router();
  router.get('/dev/checkout', (_req, res) => {
    res.type('html').send(CHECKOUT_PAGE);
  });
  return router;
}
