/** Milliseconds left until `expiresAt`, never below zero. */
export function remainingMs(expiresAt: string | Date, now = Date.now()): number {
  return Math.max(0, new Date(expiresAt).getTime() - now);
}

/** 299_400 -> "4:59". Rounds up, so "0:00" appears only when the time is really up. */
export function formatCountdown(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
