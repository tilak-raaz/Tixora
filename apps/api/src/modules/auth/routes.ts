import { Router } from 'express';
import type { Auth } from './auth';
import { requireAuth } from './middleware';

/**
 * Our own auth-related routes under /api/v1. Sign-up, sign-in and sign-out are
 * Better Auth's endpoints under /api/auth (mounted in app.ts).
 */
export function authRouter(deps: { auth: Auth }): Router {
  const router = Router();

  router.get('/me', requireAuth(deps.auth), (req, res) => {
    const { user } = req.auth!;
    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        role: user.role ?? 'user',
        createdAt: user.createdAt,
      },
    });
  });

  return router;
}
