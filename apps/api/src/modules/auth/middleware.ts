import { fromNodeHeaders } from 'better-auth/node';
import type { RequestHandler } from 'express';
import { AppError } from '../../lib/errors';
import type { Auth } from './auth';

export type Role = 'user' | 'admin';

/**
 * Rejects the request with 401 unless it carries a valid session cookie, and
 * puts the session on req.auth for the handlers after it.
 */
export function requireAuth(auth: Auth): RequestHandler {
  return async (req, _res, next) => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    }
    req.auth = session;
    next();
  };
}

/** Use after requireAuth. Rejects with 403 unless the user has the role. */
export function requireRole(role: Role): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    }
    // The admin plugin stores roles as a comma-separated string.
    const roles = (req.auth.user.role ?? 'user').split(',');
    if (!roles.includes(role)) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have access to this resource');
    }
    next();
  };
}
