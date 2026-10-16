import { describe, expect, it } from 'vitest';
import { groupBookings, ticketReference, type BookingSummary } from '@/lib/bookings';

const NOW = Date.parse('2026-10-17T10:00:00Z');

const booking = (
  id: string,
  status: BookingSummary['status'],
  startsAt: string,
): BookingSummary => ({
  id,
  showId: 'show',
  status,
  totalPaise: 20_000,
  expiresAt: '2026-10-17T10:05:00Z',
  createdAt: '2026-10-17T09:00:00Z',
  show: {
    startsAt,
    timezone: 'Asia/Kolkata',
    movieTitle: 'Monsoon Express',
    certificate: 'UA13+',
    theatre: 'Steel City Cinemas',
    screen: 'Audi 1',
  },
  seats: ['A1'],
});

describe('groupBookings', () => {
  it('splits bookings into waiting, coming up (soonest first), watched and not booked', () => {
    const groups = groupBookings(
      [
        booking('later', 'CONFIRMED', '2026-10-20T14:00:00Z'),
        booking('pending', 'PENDING_PAYMENT', '2026-10-18T14:00:00Z'),
        booking('soon', 'CONFIRMED', '2026-10-18T14:00:00Z'),
        booking('watched', 'CONFIRMED', '2026-10-10T14:00:00Z'),
        booking('expired', 'EXPIRED', '2026-10-18T14:00:00Z'),
        booking('released', 'CANCELLED', '2026-10-18T14:00:00Z'),
      ],
      NOW,
    );
    const ids = (list: BookingSummary[]) => list.map((b) => b.id);
    expect(ids(groups.awaitingPayment)).toEqual(['pending']);
    expect(ids(groups.upcoming)).toEqual(['soon', 'later']);
    expect(ids(groups.past)).toEqual(['watched']);
    expect(ids(groups.ended)).toEqual(['expired', 'released']);
  });
});

describe('ticketReference', () => {
  it('matches the reference printed on the PDF', () => {
    expect(ticketReference('c764a99e-8af7-455d-a0ff-e2f531204802')).toBe('C764A99E');
  });
});
