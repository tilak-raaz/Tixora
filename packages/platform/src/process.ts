import type { Logger } from 'pino';

export interface ProcessHandlersConfig {
  logger: Logger;
  /** Hard limit for close(); after this the process exits with code 1. */
  timeoutMs: number;
  /** Stop taking new work, finish in-flight work, then close connections. */
  close: () => Promise<void>;
}

/**
 * Graceful shutdown on SIGTERM/SIGINT (Docker and Ctrl+C), and a loud exit on
 * bugs that escape every handler. A replica restarted during a deploy should
 * finish the requests it is serving instead of cutting them off mid-payment.
 */
export function installProcessHandlers({ logger, timeoutMs, close }: ProcessHandlersConfig): void {
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const timer = setTimeout(() => {
      logger.error({ timeoutMs }, 'shutdown timed out, forcing exit');
      process.exit(1);
    }, timeoutMs);
    timer.unref();

    close().then(
      () => {
        logger.info('shutdown complete');
        process.exit(0);
      },
      (err: unknown) => {
        logger.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    process.exit(1);
  });
}
