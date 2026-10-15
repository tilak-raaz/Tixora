import { z } from 'zod';

export const bookingIdParam = z.object({ id: z.uuid() });

/** Built from config so the seat limit is not hard-coded. */
export function createHoldSchema(maxSeats: number) {
  return z.object({
    showId: z.uuid(),
    seatIds: z
      .array(z.uuid())
      .min(1)
      .max(maxSeats, `at most ${maxSeats} seats per booking`)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'seats must be unique' }),
  });
}

export type HoldInput = z.output<ReturnType<typeof createHoldSchema>>;
