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

/** A booking in My bookings (GET /bookings), with what the list shows of its show. */
export interface BookingSummary {
  id: string;
  showId: string;
  status: Booking['status'];
  totalPaise: number;
  expiresAt: string;
  createdAt: string;
  show: {
    startsAt: string;
    timezone: string;
    movieTitle: string;
    certificate: string;
    theatre: string;
    screen: string;
  };
  seats: string[];
}

export async function listBookings(): Promise<BookingSummary[]> {
  const { bookings } = await api<{ bookings: BookingSummary[] }>('/bookings');
  return bookings;
}

export interface BookingGroups {
  upcoming: BookingSummary[];
  awaitingPayment: BookingSummary[];
  past: BookingSummary[];
  ended: BookingSummary[];
}

/** Splits My bookings into what is coming up, what still needs paying, what has been, and the rest. */
export function groupBookings(bookings: BookingSummary[], now = Date.now()): BookingGroups {
  const groups: BookingGroups = { upcoming: [], awaitingPayment: [], past: [], ended: [] };
  for (const booking of bookings) {
    if (booking.status === 'CONFIRMED') {
      const startsAt = new Date(booking.show.startsAt).getTime();
      (startsAt > now ? groups.upcoming : groups.past).push(booking);
    } else if (booking.status === 'PENDING_PAYMENT') {
      groups.awaitingPayment.push(booking);
    } else {
      groups.ended.push(booking);
    }
  }
  // Soonest show first for what is coming up.
  groups.upcoming.sort(
    (a, b) => new Date(a.show.startsAt).getTime() - new Date(b.show.startsAt).getTime(),
  );
  return groups;
}

/** The short reference printed on the ticket (same as the PDF): the booking id's first 8 characters. */
export function ticketReference(bookingId: string): string {
  return bookingId.slice(0, 8).toUpperCase();
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
