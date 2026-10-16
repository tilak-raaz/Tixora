/**
 * Liveness for the container's health check: the Next.js server is up and answering. It calls
 * nothing else, so an API outage never makes Docker think the web server is broken.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return new Response('ok\n', {
    headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
  });
}
