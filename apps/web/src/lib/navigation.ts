/**
 * Where to go after signing in. Only paths on this site are allowed, so a crafted link like
 * /login?next=https://evil.example cannot send someone elsewhere.
 */
export function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) {
    return '/';
  }
  return next;
}
