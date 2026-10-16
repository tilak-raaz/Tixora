import { api } from './api';

/** A booking as its owner sees it (GET /bookings/:id). */
export interface Booking {
  id: string;
  showId: string;
  status: 'PENDING_PAYMENT' | 'CONFIRMED' | 'EXPIRED' | 'CANCELLED';
  totalPaise: number;
  expiresAt: string;
  createdAt: string;
  seats: { id: string; row: string; number: number; category: string; pricePaise: number }[];
}

/**
 * Holds seats. The idempotency key makes a retry after a network failure safe: the API answers
 * it with the first attempt's booking instead of making a second one.
 */
export async function holdSeats(
  showId: string,
  seatIds: string[],
  idempotencyKey: string,
): Promise<Booking> {
  const { booking } = await api<{ booking: Booking }>('/bookings', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    json: { showId, seatIds },
  });
  return booking;
}

export async function getBooking(id: string): Promise<Booking> {
  const { booking } = await api<{ booking: Booking }>(`/bookings/${encodeURIComponent(id)}`);
  return booking;
}

export async function releaseHold(id: string): Promise<Booking> {
  const { booking } = await api<{ booking: Booking }>(`/bookings/${encodeURIComponent(id)}/hold`, {
    method: 'DELETE',
  });
  return booking;
}

/** Where the browser remembers its latest hold per show, to find it again after a refresh. */
export function lastHoldKey(showId: string): string {
  return `bmt:hold:${showId}`;
}

/** Where a selection waits while the buyer signs in. */
export function pendingSelectionKey(showId: string): string {
  return `bmt:selection:${showId}`;
}
