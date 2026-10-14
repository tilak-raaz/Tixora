import type { ErrorBody, ErrorCode } from '@bmt/shared';
import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';

function body(code: ErrorCode, message: string, requestId: string, details?: unknown): ErrorBody {
  return {
    error: { code, message, requestId, ...(details === undefined ? {} : { details }) },
  };
}

/** express.json() throws this shape when the body is not valid JSON. */
function isMalformedJson(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    (err as { type: unknown }).type === 'entity.parse.failed'
  );
}

/** Last middleware: turns every thrown error into the standard error body. */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const requestId = String(req.id);

  if (err instanceof AppError) {
    res.status(err.status).json(body(err.code, err.message, requestId, err.details));
    return;
  }

  if (err instanceof ZodError) {
    const details = err.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    }));
    res
      .status(400)
      .json(body('VALIDATION_FAILED', 'Request validation failed', requestId, details));
    return;
  }

  if (isMalformedJson(err)) {
    res.status(400).json(body('VALIDATION_FAILED', 'Malformed JSON body', requestId));
    return;
  }

  req.log.error({ err }, 'unhandled error');
  res.status(500).json(body('INTERNAL', 'Something went wrong', requestId));
};
