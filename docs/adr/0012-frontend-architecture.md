# 0012. Frontend: Next.js App Router on the same origin as the API

- Status: Accepted
- Date: 2026-10-16

## Context

M6 adds the web app: browse movies and shows, pick seats, pay, see the ticket. The API already
exists and owns every rule; the frontend must not duplicate any of them. Three questions shaped
the setup:

- **How does the browser reach the API?** Calling `localhost:4000` from a page on
  `localhost:3000` is cross-origin: it needs CORS, `credentials: 'include'` everywhere, and a
  session cookie that works across sites (`SameSite=None; Secure`, which plain-HTTP local
  development cannot set). Rate limits by IP also need the real client address.
- **What renders where?** Browsing is public, read-heavy and already cached by the API (ADR 0011).
  The seat map, checkout and account pages are per user and change by the second.
- **How much UI infrastructure?** A component library would be most of the dependency weight for
  a handful of screens.

## Decision

- **One origin.** The browser only ever talks to the web app's origin. `/api/*` is forwarded to
  the API: by a Next.js rewrite in development, and by nginx in production (M7), where it goes
  straight to the API replicas without passing through Next.js. The session cookie is
  first-party, there is no CORS, and nginx sets `X-Forwarded-For` so per-IP limits keep working
  (the API trusts one proxy hop).
- **Next.js App Router.** Browse pages are server components that fetch the API directly
  (`API_URL`); interactive pages (seat map, checkout, bookings) are client components calling
  `/api/v1` through one typed `api()` helper that turns every error body into an `ApiError` with
  the API's error code. Sign-in uses Better Auth's React client against `/api/auth`.
- **Tailwind CSS with our own tokens** (red primary, ink, surface) and a few small components
  (button, tag, sheet on `<dialog>`, toast, skeleton). No component library.
- **The API stays the only authority.** The web app validates nothing that matters: holds, prices
  and payment state always come from the API's answers.

## Consequences

- Development needs the API running for the web app to do anything (`make dev-api`, then
  `make dev-web`).
- Locally every request reaches the API from the Next.js server's address, so per-IP limits treat
  all local traffic as one client. That is fine for development; production goes through nginx.
- Live seat updates (Server-Sent Events) must pass through the same proxies without buffering;
  that is settled with the seat-events work.
- Anyone can still call the API directly; the frontend is a client of the API, not a gate in
  front of it.
