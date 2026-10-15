import type { Pool, PoolClient } from '@bmt/platform';

type Db = Pool | PoolClient;

export async function findShowForHold(
  db: Db,
  showId: string,
): Promise<{ bookable: boolean } | undefined> {
  const { rows } = await db.query<{ bookable: boolean }>(
    `SELECT status = 'SCHEDULED' AND starts_at > now() AS bookable FROM shows WHERE id = $1`,
    [showId],
  );
  return rows[0];
}

/**
 * Expires this user's own pending booking for the show if its hold has run out,
 * and frees its seats, so an old hold never blocks a new one. (The sweeper in
 * the next PR does the same for everyone in the background.)
 */
export async function expireStaleHold(db: Db, userId: string, showId: string): Promise<void> {
  await db.query(
    `WITH expired AS (
       UPDATE bookings SET status = 'EXPIRED'
       WHERE user_id = $1 AND show_id = $2 AND status = 'PENDING_PAYMENT' AND expires_at <= now()
       RETURNING id
     )
     UPDATE show_seats
     SET status = 'AVAILABLE', booking_id = NULL, held_until = NULL, version = version + 1
     WHERE booking_id IN (SELECT id FROM expired) AND status = 'HELD'`,
    [userId, showId],
  );
}

/** Prices of the requested seats that belong to this show. */
export async function findSeatPrices(
  db: Db,
  showId: string,
  showSeatIds: string[],
): Promise<{ id: string; price_paise: number }[]> {
  const { rows } = await db.query<{ id: string; price_paise: number }>(
    'SELECT id, price_paise FROM show_seats WHERE show_id = $1 AND id = ANY($2::uuid[])',
    [showId, showSeatIds],
  );
  return rows;
}

export async function insertBooking(
  db: Db,
  booking: { userId: string; showId: string; totalPaise: number; holdTtlSeconds: number },
): Promise<{ id: string; expiresAt: Date }> {
  const { rows } = await db.query<{ id: string; expiresAt: Date }>(
    `INSERT INTO bookings (user_id, show_id, total_paise, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4))
     RETURNING id, expires_at AS "expiresAt"`,
    [booking.userId, booking.showId, booking.totalPaise, booking.holdTtlSeconds],
  );
  return rows[0]!;
}

export async function insertBookingSeats(
  db: Db,
  bookingId: string,
  seats: { id: string; price_paise: number }[],
): Promise<void> {
  await db.query(
    `INSERT INTO booking_seats (booking_id, show_seat_id, price_paise)
     SELECT $1, * FROM unnest($2::uuid[], $3::int[])`,
    [bookingId, seats.map((s) => s.id), seats.map((s) => s.price_paise)],
  );
}

export interface BookingView {
  id: string;
  showId: string;
  status: string;
  totalPaise: number;
  expiresAt: Date;
  createdAt: Date;
  seats: { id: string; row: string; number: number; category: string; pricePaise: number }[];
}

/**
 * A booking as its owner sees it. A pending booking whose hold has run out is
 * reported as EXPIRED even before the sweeper updates the row.
 */
export async function findBookingView(
  db: Db,
  bookingId: string,
  userId: string,
): Promise<BookingView | undefined> {
  const { rows } = await db.query<BookingView>(
    `SELECT b.id, b.show_id AS "showId",
            CASE WHEN b.status = 'PENDING_PAYMENT' AND b.expires_at <= now()
                 THEN 'EXPIRED' ELSE b.status END AS status,
            b.total_paise AS "totalPaise", b.expires_at AS "expiresAt", b.created_at AS "createdAt",
            (SELECT json_agg(json_build_object(
                      'id', ss.id, 'row', s.row_label, 'number', s.seat_number,
                      'category', cat.name, 'pricePaise', bs.price_paise)
                    ORDER BY s.row_label, s.seat_number)
             FROM booking_seats bs
             JOIN show_seats ss ON ss.id = bs.show_seat_id
             JOIN seats s ON s.id = ss.seat_id
             JOIN seat_categories cat ON cat.id = s.category_id
             WHERE bs.booking_id = b.id) AS seats
     FROM bookings b
     WHERE b.id = $1 AND b.user_id = $2`,
    [bookingId, userId],
  );
  return rows[0];
}

/** Cancels an active hold. Returns false if the booking is not an active hold of this user. */
export async function cancelHold(db: Db, bookingId: string, userId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE bookings SET status = 'CANCELLED', cancelled_at = now()
     WHERE id = $1 AND user_id = $2 AND status = 'PENDING_PAYMENT' AND expires_at > now()`,
    [bookingId, userId],
  );
  return rowCount === 1;
}

export async function releaseSeats(db: Db, bookingId: string): Promise<void> {
  await db.query(
    `UPDATE show_seats
     SET status = 'AVAILABLE', booking_id = NULL, held_until = NULL, version = version + 1
     WHERE booking_id = $1 AND status = 'HELD'`,
    [bookingId],
  );
}
