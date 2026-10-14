import { randomUUID } from 'node:crypto';
import type { Logger } from '@bmt/platform';
import { pinoHttp } from 'pino-http';

/** Accept a caller's request ID only if it looks like one. */
const REQUEST_ID = /^[\w-]{8,64}$/;

/**
 * Logs every request as one JSON line and gives it an ID. The ID comes from an
 * incoming x-request-id header (set by nginx in M7) or is generated, is echoed
 * back in the response header, and is available as req.id and in req.log.
 * Later it is copied into every queue job the request creates.
 */
export function requestLogger(logger: Logger) {
  return pinoHttp({
    logger,
    genReqId: (req, res) => {
      const incoming = req.headers['x-request-id'];
      const id =
        typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
      res.setHeader('x-request-id', id);
      return id;
    },
    autoLogging: {
      // Health checks hit every few seconds; logging them is noise.
      ignore: (req) => req.url === '/healthz' || req.url === '/readyz',
    },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  });
}
