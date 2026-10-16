import { renderTicketPdf, ticketFilename, ticketQrPayload, ticketReference } from '@bmt/jobs';
import { describe, expect, it } from 'vitest';

const booking = {
  bookingId: '3f2a9c1e-1111-4222-8333-444455556666',
  userName: 'Tilak',
  userEmail: 'buyer@example.com',
  movieTitle: 'Interstellar',
  theatreName: 'PVR Rourkela',
  theatreAddress: 'Mall Road',
  screenName: 'Audi 2',
  startsAt: new Date('2026-10-20T13:30:00Z'),
  timezone: 'Asia/Kolkata',
  totalPaise: 56_000,
  seats: [
    { row: 'F', number: 7, category: 'Gold' },
    { row: 'F', number: 8, category: 'Gold' },
  ],
};

describe('ticket', () => {
  it('names and references the booking by the first 8 characters of its id', () => {
    expect(ticketReference(booking.bookingId)).toBe('3F2A9C1E');
    expect(ticketFilename(booking.bookingId)).toBe('ticket-3F2A9C1E.pdf');
    expect(ticketQrPayload(booking.bookingId)).toBe(`BMT:${booking.bookingId}`);
  });

  it('renders one page with the QR code as an image', async () => {
    const pdf = await renderTicketPdf(booking);
    const raw = pdf.toString('latin1');

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(raw.match(/\/Type \/Page\b/g)).toHaveLength(1);
    expect(raw).toContain('/Subtype /Image');
  });
});
