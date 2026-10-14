/**
 * Every error the API returns has one of these codes. Clients branch on the
 * code, never on the message. Add domain codes (SEAT_UNAVAILABLE, HOLD_EXPIRED, ...)
 * in the milestone that introduces them.
 */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** The single error response shape used by every endpoint. */
export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}
