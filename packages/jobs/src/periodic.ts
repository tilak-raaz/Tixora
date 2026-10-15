import type { Logger } from '@bmt/platform';

export interface Periodic {
  /** Stops scheduling runs and waits for one in progress to finish. */
  stop(): Promise<void>;
}

/**
 * Runs `task` once now, then again `intervalMs` after each run ends (never
 * overlapping itself), with ±20% jitter so several workers do not run in step.
 * A failing run is logged and the next one still happens.
 */
export function startPeriodic(
  name: string,
  task: () => Promise<void>,
  opts: { intervalMs: number; logger: Logger },
): Periodic {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  const loop = (): void => {
    if (stopped) return;
    running = task()
      .catch((err: unknown) => opts.logger.error({ err }, `${name} failed`))
      .then(() => {
        if (!stopped) timer = setTimeout(loop, opts.intervalMs * (0.8 + Math.random() * 0.4));
      });
  };
  loop();

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
