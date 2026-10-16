import { headers } from 'next/headers';
import { api, type ApiRequest } from './api';
import { clientIp } from './forwarded';

/**
 * api() for server components. They call the API directly, not through nginx, so without help
 * every visitor's requests would arrive from the Next.js server's address and share one per-IP
 * rate limit. Passing the visitor's address on keeps those limits per visitor (the API trusts
 * one proxy hop).
 */
export async function serverApi<T>(path: string, request: ApiRequest = {}): Promise<T> {
  const incoming = await headers();
  const outgoing = new Headers(request.headers);
  const ip = clientIp(incoming.get('x-forwarded-for'));
  if (ip) outgoing.set('X-Forwarded-For', ip);
  return api<T>(path, { cache: 'no-store', ...request, headers: outgoing });
}
