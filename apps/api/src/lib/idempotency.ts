import { createHash } from 'node:crypto';
import type { Pool } from '@bmt/platform';
import { AppError } from './errors';

export interface IdempotentResult {
  status: number;
  body: unknown;
  /** True when this response was stored by an earlier request with the same key. */
  replayed: boolean;
}

/** A claim older than this with no response is treated as abandoned (its process died). */
const ABANDONED_AFTER_SECONDS = 60;

/** Stable hash of a request, so a key reused for a different request is caught. */
export function hashRequest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Runs `work` at most once per (user, key). A client that retries a POST with
 * the same Idempotency-Key, for example after a timeout, gets the first
 * response back instead of a second booking.
 *
 * 1. Claim the key with an INSERT. The primary key makes exactly one concurrent
 *    request the owner.
 * 2. The owner runs the work and stores its response. If the work fails, the
 *    claim is removed so the client can retry with the same key.
 * 3. Everyone else replays the stored response, or gets 409 while the owner is
 *    still running.
 */
export async function idempotent(
  pool: Pool,
  claim: { userId: string; key: string; requestHash: string },
  work: () => Promise<{ status: number; body: unknown }>,
): Promise<IdempotentResult> {
  const { userId, key, requestHash } = claim;

  const claimed = await pool.query(
    `INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, key) DO NOTHING`,
    [userId, key, requestHash],
  );

  if (claimed.rowCount === 0) {
    const { rows } = await pool.query<{
      request_hash: string;
      response_status: number | null;
      response_body: unknown;
      abandoned: boolean;
    }>(
      `SELECT request_hash, response_status, response_body,
              created_at < now() - make_interval(secs => $3) AS abandoned
       FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
      [userId, key, ABANDONED_AFTER_SECONDS],
    );
    const existing = rows[0];
    if (!existing) {
      // The owner failed and released the key between our INSERT and SELECT. Retry the claim.
      return idempotent(pool, claim, work);
    }
    if (existing.request_hash !== requestHash) {
      throw new AppError(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used for a different request',
      );
    }
    if (existing.response_status !== null) {
      return { status: existing.response_status, body: existing.response_body, replayed: true };
    }
    // Still running elsewhere, unless its owner died: then take the claim over.
    const takenOver = existing.abandoned
      ? await pool.query(
          `UPDATE idempotency_keys SET created_at = now()
           WHERE user_id = $1 AND key = $2 AND response_status IS NULL
             AND created_at < now() - make_interval(secs => $3)`,
          [userId, key, ABANDONED_AFTER_SECONDS],
        )
      : { rowCount: 0 };
    if (takenOver.rowCount === 0) {
      throw new AppError(
        409,
        'REQUEST_IN_PROGRESS',
        'A request with this Idempotency-Key is still being processed; retry shortly',
      );
    }
  }

  try {
    const result = await work();
    await pool.query(
      `UPDATE idempotency_keys SET response_status = $3, response_body = $4
       WHERE user_id = $1 AND key = $2`,
      [userId, key, result.status, JSON.stringify(result.body)],
    );
    return { ...result, replayed: false };
  } catch (err) {
    await pool
      .query(
        'DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2 AND response_status IS NULL',
        [userId, key],
      )
      .catch(() => undefined);
    throw err;
  }
}
