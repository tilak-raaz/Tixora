import type { ErrorCode } from '@bmt/shared';

/**
 * Throw an AppError (or a subclass) for any failure the client should see.
 * The error middleware turns it into the standard error body; anything else
 * becomes a 500 with no internal details leaked.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, 'NOT_FOUND', message);
  }
}
