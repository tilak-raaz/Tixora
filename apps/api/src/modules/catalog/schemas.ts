import { z } from 'zod';

// ---------- shared pieces ----------

export const idParam = z.object({ id: z.uuid() });
export const slugParam = z.object({ slug: z.string().min(1).max(100) });

/** A calendar date in the city's own time zone, e.g. 2026-10-20. Defaults to today there. */
export const dateQuery = z.object({ date: z.iso.date().optional() });

export const movieShowsQuery = z.object({
  city: z.string().min(1).max(100),
  date: z.iso.date().optional(),
});

// ---------- admin input ----------

export const createCitySchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase letters, digits and single hyphens only'),
  state: z.string().trim().min(1).max(100),
  timezone: z.string().min(1).default('Asia/Kolkata'),
});

export const createSeatCategorySchema = z.object({
  name: z.string().trim().min(1).max(50),
  sortOrder: z.number().int().min(0).default(0),
});

export const createTheatreSchema = z.object({
  cityId: z.uuid(),
  name: z.string().trim().min(1).max(100),
  address: z.string().trim().min(1).max(300),
});

/**
 * A screen is created with its whole seat layout. Each row lists its seats in
 * order; `aisleAfter` leaves an empty grid cell after those seat numbers.
 * Rows are listed front (nearest the screen) to back.
 */
export const createScreenSchema = z.object({
  theatreId: z.uuid(),
  name: z.string().trim().min(1).max(50),
  rows: z
    .array(
      z.object({
        label: z.string().regex(/^[A-Z]{1,2}$/, 'one or two capital letters'),
        categoryId: z.uuid(),
        seats: z.number().int().min(1).max(60),
        aisleAfter: z.array(z.number().int().positive()).default([]),
      }),
    )
    .min(1)
    .max(40)
    .refine((rows) => new Set(rows.map((r) => r.label)).size === rows.length, {
      message: 'row labels must be unique',
    }),
});

export const createMovieSchema = z.object({
  title: z.string().trim().min(1).max(200),
  language: z.string().trim().min(1).max(50),
  durationMin: z.number().int().min(1).max(600),
  certificate: z.string().trim().max(10).optional(),
  releaseDate: z.iso.date(),
  description: z.string().max(2000).optional(),
  posterUrl: z.url().optional(),
});

export const createShowSchema = z.object({
  movieId: z.uuid(),
  screenId: z.uuid(),
  /** ISO 8601 with an offset, e.g. 2026-10-20T18:30:00+05:30 */
  startsAt: z.iso.datetime({ offset: true }),
  /** One price per seat category on the screen, in paise. */
  prices: z
    .array(z.object({ categoryId: z.uuid(), pricePaise: z.number().int().positive() }))
    .min(1),
});

export type CreateCityInput = z.output<typeof createCitySchema>;
export type CreateSeatCategoryInput = z.output<typeof createSeatCategorySchema>;
export type CreateTheatreInput = z.output<typeof createTheatreSchema>;
export type CreateScreenInput = z.output<typeof createScreenSchema>;
export type CreateMovieInput = z.output<typeof createMovieSchema>;
export type CreateShowInput = z.output<typeof createShowSchema>;
