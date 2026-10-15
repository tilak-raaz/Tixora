import type { Logger, Pool, Redis } from '@bmt/platform';
import { toNodeHandler } from 'better-auth/node';
import express, { Router, type Express } from 'express';
import { errorHandler } from './middleware/error-handler';
import { notFoundHandler } from './middleware/not-found';
import { requestLogger } from './middleware/request-logger';
import type { Auth } from './modules/auth/auth';
import { authRouter } from './modules/auth/routes';
import { adminCatalogRouter, catalogRouter } from './modules/catalog/routes';
import { healthRouter } from './routes/health';

export interface AppDeps {
  logger: Logger;
  pool: Pool;
  redis: Redis;
  auth: Auth;
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

  // Better Auth's endpoints (sign-up, sign-in, sign-out, get-session).
  // Mounted before express.json() because Better Auth reads the raw body itself.
  app.all('/api/auth/*splat', toNodeHandler(deps.auth));

  app.use(express.json({ limit: '100kb' }));

  // Ops endpoints live at the root, outside the versioned API.
  app.use(healthRouter(deps));

  const v1 = Router();
  v1.use(authRouter(deps));
  v1.use(catalogRouter(deps));
  v1.use('/admin', adminCatalogRouter(deps));
  app.use('/api/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
