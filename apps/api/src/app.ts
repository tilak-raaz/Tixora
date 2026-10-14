import type { Logger, Pool, Redis } from '@bmt/platform';
import express, { Router, type Express } from 'express';
import { errorHandler } from './middleware/error-handler';
import { notFoundHandler } from './middleware/not-found';
import { requestLogger } from './middleware/request-logger';
import { healthRouter } from './routes/health';

export interface AppDeps {
  logger: Logger;
  pool: Pool;
  redis: Redis;
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
  app.use(express.json({ limit: '100kb' }));

  // Ops endpoints live at the root, outside the versioned API.
  app.use(healthRouter(deps));

  const v1 = Router();
  // Feature modules mount here from M1: v1.use('/auth', authRouter(deps)), ...
  app.use('/api/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
