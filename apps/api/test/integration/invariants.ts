import type { Pool } from '@bmt/platform';

/**
 * Money and seat invariants that must hold after any sequence of events,
 * however duplicated, reordered or late. Returns what is broken; [] means all
 * hold. Scoped to the given shows, because other test files leave hand-made
 * rows behind on purpose. Run after every webhook test (and in M7 after load
 * tests and failure drills, over everything).
 */
export async function checkInvariants(pool: Pool, showIds: string[]): Promise<string[]> {
  const checks: [string, string][] = [
    [
      'a CONFIRMED booking has exactly one applied payment',
      `SELECT b.id FROM bookings b
       LEFT JOIN payment_orders po ON po.booking_id = b.id
       LEFT JOIN payments p ON p.order_id = po.id AND p.applied
       WHERE b.status = 'CONFIRMED' AND b.show_id = ANY($1::uuid[])
       GROUP BY b.id HAVING count(p.id) <> 1`,
    ],
    [
      'every seat of a CONFIRMED booking is BOOKED by it',
      `SELECT b.id FROM bookings b
       JOIN booking_seats bs ON bs.booking_id = b.id
       JOIN show_seats ss ON ss.id = bs.show_seat_id
       WHERE b.status = 'CONFIRMED' AND b.show_id = ANY($1::uuid[])
         AND (ss.status <> 'BOOKED' OR ss.booking_id IS DISTINCT FROM b.id)`,
    ],
    [
      'a BOOKED seat belongs to a CONFIRMED booking',
      `SELECT ss.id FROM show_seats ss JOIN bookings b ON b.id = ss.booking_id
       WHERE ss.status = 'BOOKED' AND b.status <> 'CONFIRMED' AND ss.show_id = ANY($1::uuid[])`,
    ],
    [
      'an applied payment belongs to a CONFIRMED booking and is never refunded',
      `SELECT p.id FROM payments p
       JOIN payment_orders po ON po.id = p.order_id
       JOIN bookings b ON b.id = po.booking_id
       LEFT JOIN refunds r ON r.payment_id = p.id
       WHERE p.applied AND b.show_id = ANY($1::uuid[])
         AND (b.status <> 'CONFIRMED' OR r.id IS NOT NULL)`,
    ],
    [
      'every payment that did not confirm a booking is refunded',
      `SELECT p.id FROM payments p
       JOIN payment_orders po ON po.id = p.order_id
       JOIN bookings b ON b.id = po.booking_id
       LEFT JOIN refunds r ON r.payment_id = p.id
       WHERE NOT p.applied AND r.id IS NULL AND b.show_id = ANY($1::uuid[])`,
    ],
    [
      'an applied payment is for exactly the booking total',
      `SELECT p.id FROM payments p
       JOIN payment_orders po ON po.id = p.order_id
       JOIN bookings b ON b.id = po.booking_id
       WHERE p.applied AND p.amount_paise <> b.total_paise AND b.show_id = ANY($1::uuid[])`,
    ],
  ];

  const broken: string[] = [];
  for (const [rule, sql] of checks) {
    const { rows } = await pool.query<{ id: string }>(sql, [showIds]);
    if (rows.length > 0) broken.push(`${rule}: ${rows.map((r) => r.id).join(', ')}`);
  }
  return broken;
}
