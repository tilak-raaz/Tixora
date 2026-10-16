import type { Pool, PoolClient } from 'pg';

/**
 * The transactional outbox (ADR 0008): the one way a state change causes a
 * side effect. Write the event with the same client, inside the same
 * transaction, as the change it announces; the worker's relay does the rest.
 */

export const OUTBOX_TOPICS = ['booking.confirmed', 'refund.recorded'] as const;
export type OutboxTopic = (typeof OUTBOX_TOPICS)[number];

export interface OutboxPayloads {
  'booking.confirmed': { bookingId: string };
  'refund.recorded': { refundId: string; bookingId: string; reason: string };
}

export interface OutboxEvent<T extends OutboxTopic = OutboxTopic> {
  id: string;
  topic: T;
  payload: OutboxPayloads[T];
  requestId: string | null;
}

export async function writeOutbox<T extends OutboxTopic>(
  tx: PoolClient | Pool,
  topic: T,
  payload: OutboxPayloads[T],
  opts: { aggregateId: string; requestId?: string },
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO outbox (topic, aggregate_id, payload, request_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [topic, opts.aggregateId, JSON.stringify(payload), opts.requestId ?? null],
  );
  return rows[0]!.id;
}
