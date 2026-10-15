import type { Pool, PoolClient } from '@bmt/platform';

type Db = Pool | PoolClient;

export interface PayableBooking {
  id: string;
  status: string;
  totalPaise: number;
  expiresAt: Date;
  /** Measured by Postgres, the clock every hold decision uses. */
  secondsLeft: number;
}

export async function findBookingForPayment(
  db: Db,
  bookingId: string,
  userId: string,
): Promise<PayableBooking | undefined> {
  const { rows } = await db.query<PayableBooking>(
    `SELECT id, status, total_paise AS "totalPaise", expires_at AS "expiresAt",
            extract(epoch FROM expires_at - now())::float8 AS "secondsLeft"
     FROM bookings WHERE id = $1 AND user_id = $2`,
    [bookingId, userId],
  );
  return rows[0];
}

export interface OrderRow {
  razorpayOrderId: string;
  amountPaise: number;
  currency: string;
}

export async function findOrder(db: Db, bookingId: string): Promise<OrderRow | undefined> {
  const { rows } = await db.query<OrderRow>(
    `SELECT razorpay_order_id AS "razorpayOrderId", amount_paise AS "amountPaise", currency
     FROM payment_orders WHERE booking_id = $1`,
    [bookingId],
  );
  return rows[0];
}

/** Stores the order unless the booking already has one. Returns whether this call stored it. */
export async function insertOrder(
  db: Db,
  order: { bookingId: string; razorpayOrderId: string; amountPaise: number },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO payment_orders (booking_id, razorpay_order_id, amount_paise)
     VALUES ($1, $2, $3)
     ON CONFLICT (booking_id) DO NOTHING`,
    [order.bookingId, order.razorpayOrderId, order.amountPaise],
  );
  return rowCount === 1;
}
