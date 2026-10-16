/**
 * How many live seat maps one address may keep open on this replica. Open streams are
 * connections to this process, so they are counted here rather than in Redis: a crashed replica
 * takes its counts with it instead of leaving them stuck. Opening streams is also rate limited
 * per IP across replicas, by the browse limit.
 */
export interface StreamLimiter {
  /** False when the address is at its limit. */
  tryAcquire(key: string): boolean;
  release(key: string): void;
}

export function createStreamLimiter(maxPerKey: number): StreamLimiter {
  const open = new Map<string, number>();
  return {
    tryAcquire(key) {
      const count = open.get(key) ?? 0;
      if (count >= maxPerKey) return false;
      open.set(key, count + 1);
      return true;
    },
    release(key) {
      const count = open.get(key) ?? 0;
      if (count <= 1) open.delete(key);
      else open.set(key, count - 1);
    },
  };
}
