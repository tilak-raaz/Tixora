/**
 * The visitor's address from X-Forwarded-For as the Next.js server received it. In production
 * nginx appends the address it saw, so the last entry is the one we can trust; anything before it
 * came from the client and may be made up. Undefined when there is no proxy (local development).
 */
export function clientIp(forwardedFor: string | null): string | undefined {
  if (!forwardedFor) return undefined;
  const entries = forwardedFor
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.at(-1);
}
