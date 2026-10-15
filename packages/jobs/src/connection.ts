import type { ConnectionOptions } from 'bullmq';

/** Every BullMQ key starts with this, next to the app's other `bmt:` keys. */
export const QUEUE_PREFIX = 'bmt:bull';

export interface QueueOptions {
  /** Overrides QUEUE_PREFIX; tests use one per file so their queues never meet. */
  prefix?: string;
  /** Overrides the connection built from the URL (tests point this at a dead Redis). */
  connection?: ConnectionOptions;
}

/**
 * BullMQ opens and owns its own Redis connections from these options. It needs
 * settings (maxRetriesPerRequest: null on its blocking connection) that differ
 * from the shared client in @bmt/platform, so it never borrows that one.
 */
export function queueConnection(redisUrl: string, opts: QueueOptions = {}): ConnectionOptions {
  return opts.connection ?? { url: redisUrl };
}
