import type { AuthSession } from '../modules/auth/auth';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by requireAuth: the signed-in user and their session. */
    auth?: AuthSession;
  }
}

export {};
