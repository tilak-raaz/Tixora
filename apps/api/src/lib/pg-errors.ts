import { AppError } from './errors';

/** The fields of a node-postgres DatabaseError that we branch on. */
interface PgError {
  code: string;
  constraint?: string;
}

export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_EXCLUSION_VIOLATION = '23P01';

export function isPgError(err: unknown): err is PgError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    // SQLSTATE codes are five characters; Node network errors (ECONNREFUSED) are not.
    (err as { code: string }).code.length === 5
  );
}

/**
 * Turns a constraint violation into the client-facing error for it. The database
 * is the referee (two admins racing to create the same theatre both reach the
 * INSERT; only the constraint decides), so services catch here instead of
 * checking first. Anything not listed is rethrown unchanged and becomes a 500.
 */
export function rethrowConstraintError(
  err: unknown,
  messages: { unique?: string; foreignKey?: string; exclusion?: string },
): never {
  if (isPgError(err)) {
    if (err.code === PG_UNIQUE_VIOLATION && messages.unique) {
      throw new AppError(409, 'CONFLICT', messages.unique);
    }
    if (err.code === PG_EXCLUSION_VIOLATION && messages.exclusion) {
      throw new AppError(409, 'CONFLICT', messages.exclusion);
    }
    if (err.code === PG_FOREIGN_KEY_VIOLATION && messages.foreignKey) {
      throw new AppError(400, 'VALIDATION_FAILED', messages.foreignKey);
    }
  }
  throw err;
}
