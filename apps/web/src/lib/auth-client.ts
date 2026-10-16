import { createAuthClient } from 'better-auth/react';

/**
 * Better Auth's client. In the browser it calls /api/auth on the page's own origin, which Next.js
 * (nginx in production) forwards to the API, so the session cookie is first-party (ADR 0012).
 * During server rendering it talks to the API directly.
 */
export const authClient = createAuthClient({
  baseURL:
    typeof window === 'undefined'
      ? (process.env.API_URL ?? 'http://localhost:4000')
      : window.location.origin,
});
