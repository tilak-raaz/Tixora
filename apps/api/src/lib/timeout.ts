/** Rejects if `promise` has not settled within `ms`. The promise itself carries on regardless. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what = 'operation'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
