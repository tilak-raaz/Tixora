import type { Pool } from '@bmt/platform';
import { formatPaise } from '@bmt/shared';

/**
 * What goes into each email, read from Postgres when the job runs (the event
 * carries ids only, so an email always shows the current names and times),
 * and rendered as text and HTML.
 */

export interface BookingDetails {
  bookingId: string;
  userName: string;
  userEmail: string;
  movieTitle: string;
  theatreName: string;
  theatreAddress: string;
  screenName: string;
  startsAt: Date;
  timezone: string;
  totalPaise: number;
  seats: { row: string; number: number; category: string }[];
}

export async function loadBookingDetails(
  pool: Pool,
  bookingId: string,
): Promise<BookingDetails | undefined> {
  const { rows } = await pool.query<BookingDetails>(
    `SELECT b.id AS "bookingId", u.name AS "userName", u.email AS "userEmail",
            m.title AS "movieTitle", t.name AS "theatreName", t.address AS "theatreAddress",
            sc.name AS "screenName", sh.starts_at AS "startsAt", c.timezone,
            b.total_paise AS "totalPaise",
            (SELECT json_agg(json_build_object('row', s.row_label, 'number', s.seat_number,
                                               'category', cat.name)
                             ORDER BY s.row_label, s.seat_number)
             FROM booking_seats bs
             JOIN show_seats ss ON ss.id = bs.show_seat_id
             JOIN seats s ON s.id = ss.seat_id
             JOIN seat_categories cat ON cat.id = s.category_id
             WHERE bs.booking_id = b.id) AS seats
     FROM bookings b
     JOIN users u ON u.id = b.user_id
     JOIN shows sh ON sh.id = b.show_id
     JOIN movies m ON m.id = sh.movie_id
     JOIN screens sc ON sc.id = sh.screen_id
     JOIN theatres t ON t.id = sc.theatre_id
     JOIN cities c ON c.id = t.city_id
     WHERE b.id = $1`,
    [bookingId],
  );
  return rows[0];
}

export function showTime(details: Pick<BookingDetails, 'startsAt' | 'timezone'>): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: details.timezone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(new Date(details.startsAt));
}

export function seatList(details: Pick<BookingDetails, 'seats'>): string {
  return details.seats.map((s) => `${s.row}${s.number}`).join(', ');
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export function bookingConfirmedEmail(d: BookingDetails): RenderedEmail {
  const when = showTime(d);
  const seats = seatList(d);
  const ref = d.bookingId.slice(0, 8).toUpperCase();
  return {
    subject: `Booked: ${d.movieTitle}, ${when}`,
    text: [
      `Hi ${d.userName},`,
      '',
      `Your booking is confirmed.`,
      '',
      `${d.movieTitle}`,
      `${when}`,
      `${d.theatreName}, ${d.screenName}`,
      `${d.theatreAddress}`,
      `Seats: ${seats}`,
      `Paid: ${formatPaise(d.totalPaise)}`,
      `Booking reference: ${ref}`,
      '',
      'Show the attached ticket at the entrance. You can download it again from your bookings.',
    ].join('\n'),
    html: layout(`
      <p>Hi ${esc(d.userName)},</p>
      <p>Your booking is confirmed.</p>
      <h2 style="margin:16px 0 4px">${esc(d.movieTitle)}</h2>
      <p style="margin:0">${esc(when)}</p>
      <p style="margin:0">${esc(d.theatreName)}, ${esc(d.screenName)}</p>
      <p style="margin:0;color:#666">${esc(d.theatreAddress)}</p>
      <table style="margin:16px 0;border-collapse:collapse">
        ${row('Seats', esc(seats))}
        ${row('Paid', esc(formatPaise(d.totalPaise)))}
        ${row('Booking reference', `<strong>${esc(ref)}</strong>`)}
      </table>
      <p>Show the attached ticket at the entrance. You can download it again from your bookings.</p>`),
  };
}

const REFUND_REASONS: Record<string, string> = {
  HOLD_ENDED:
    'Your payment reached us after your seats were released, so we could not confirm the booking.',
  DUPLICATE_PAYMENT:
    'You paid twice for the same booking. Your booking stands; the extra payment is being returned.',
  AMOUNT_MISMATCH: 'The amount paid did not match the booking, so we could not confirm it.',
};

export function refundRecordedEmail(
  d: BookingDetails,
  refund: { reason: string; amountPaise: number },
): RenderedEmail {
  const why = REFUND_REASONS[refund.reason] ?? 'We could not apply your payment.';
  const amount = formatPaise(refund.amountPaise);
  return {
    subject: `Refund on its way: ${amount} for ${d.movieTitle}`,
    text: [
      `Hi ${d.userName},`,
      '',
      why,
      '',
      `A full refund of ${amount} has been started. Banks usually take 5 to 7 working days to show it.`,
      '',
      `Show: ${d.movieTitle}, ${showTime(d)}`,
      `Booking reference: ${d.bookingId.slice(0, 8).toUpperCase()}`,
    ].join('\n'),
    html: layout(`
      <p>Hi ${esc(d.userName)},</p>
      <p>${esc(why)}</p>
      <p>A full refund of <strong>${esc(amount)}</strong> has been started. Banks usually take
         5 to 7 working days to show it.</p>
      <p style="color:#666">Show: ${esc(d.movieTitle)}, ${esc(showTime(d))}<br>
         Booking reference: ${esc(d.bookingId.slice(0, 8).toUpperCase())}</p>`),
  };
}

function row(label: string, value: string): string {
  return `<tr><td style="padding:2px 16px 2px 0;color:#666">${label}</td><td>${value}</td></tr>`;
}

function layout(body: string): string {
  return `<!doctype html><html><body style="font:15px/1.5 system-ui,sans-serif;max-width:560px;margin:auto;padding:16px">
<p style="font-weight:600;font-size:18px">BookMyTicket</p>${body}</body></html>`;
}

/** Names come from admins and users: never trust them in HTML. */
export function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
