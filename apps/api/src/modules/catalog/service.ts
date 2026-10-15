import { withTransaction, type Pool } from '@bmt/platform';
import { AppError, NotFoundError } from '../../lib/errors';
import { rethrowConstraintError } from '../../lib/pg-errors';
import * as repo from './repo';
import type {
  CreateCityInput,
  CreateMovieInput,
  CreateScreenInput,
  CreateSeatCategoryInput,
  CreateShowInput,
  CreateTheatreInput,
} from './schemas';

/** Time between shows for cleaning; added to the movie's duration when booking the screen. */
export const CLEANING_BUFFER_MIN = 15;

export type CatalogService = ReturnType<typeof createCatalogService>;

export function createCatalogService(pool: Pool) {
  return {
    // ---------- admin ----------

    async createCity(input: CreateCityInput) {
      try {
        return await repo.insertCity(pool, input);
      } catch (err) {
        rethrowConstraintError(err, { unique: `A city with slug "${input.slug}" already exists` });
      }
    },

    async createSeatCategory(input: CreateSeatCategoryInput) {
      try {
        return await repo.insertSeatCategory(pool, input);
      } catch (err) {
        rethrowConstraintError(err, { unique: `Seat category "${input.name}" already exists` });
      }
    },

    async createTheatre(input: CreateTheatreInput) {
      try {
        return await repo.insertTheatre(pool, input);
      } catch (err) {
        rethrowConstraintError(err, {
          unique: `This city already has a theatre named "${input.name}"`,
          foreignKey: 'City not found',
        });
      }
    },

    /** Creates the screen and all its seats together, or nothing. */
    async createScreen(input: CreateScreenInput) {
      const seats = layoutToSeats(input.rows);
      try {
        return await withTransaction(pool, async (tx) => {
          const screen = await repo.insertScreen(tx, input);
          const seatCount = await repo.insertSeats(tx, screen.id, seats);
          return { id: screen.id, seatCount };
        });
      } catch (err) {
        rethrowConstraintError(err, {
          unique: `This theatre already has a screen named "${input.name}"`,
          foreignKey: 'Theatre or seat category not found',
        });
      }
    },

    async createMovie(input: CreateMovieInput) {
      try {
        return await repo.insertMovie(pool, input);
      } catch (err) {
        rethrowConstraintError(err, {
          unique: 'This movie already exists in that language for that release date',
        });
      }
    },

    /**
     * Creates the show, its prices and its whole seat inventory in one
     * transaction. The overlap rule is left to the database's exclusion
     * constraint: two admins scheduling the same slot at once both reach the
     * INSERT, and exactly one wins.
     */
    async createShow(input: CreateShowInput) {
      return withTransaction(pool, async (tx) => {
        const durationMin = await repo.findMovieDuration(tx, input.movieId);
        if (durationMin === undefined) {
          throw new AppError(400, 'VALIDATION_FAILED', 'Movie not found');
        }
        const categoryIds = await repo.findScreenCategoryIds(tx, input.screenId);
        if (categoryIds === undefined) {
          throw new AppError(400, 'VALIDATION_FAILED', 'Screen not found');
        }
        assertPricesMatchCategories(input.prices, categoryIds);
        if (Date.parse(input.startsAt) <= Date.now()) {
          throw new AppError(400, 'VALIDATION_FAILED', 'A show must start in the future');
        }

        let show: Awaited<ReturnType<typeof repo.insertShow>>;
        try {
          show = await repo.insertShow(tx, {
            movieId: input.movieId,
            screenId: input.screenId,
            startsAt: input.startsAt,
            occupiesMin: durationMin + CLEANING_BUFFER_MIN,
          });
        } catch (err) {
          rethrowConstraintError(err, { exclusion: 'This screen already has a show at that time' });
        }

        await repo.insertShowPrices(tx, show.id, input.prices);
        const seatCount = await repo.insertShowSeats(tx, show.id, input.screenId);
        return { ...show, seatCount };
      });
    },

    // ---------- public ----------

    listCities: () => repo.listCities(pool),

    async listMoviesInCity(citySlug: string, date: string | undefined) {
      if (!(await repo.cityExists(pool, citySlug))) throw new NotFoundError('City not found');
      return repo.listMoviesInCity(pool, citySlug, date ?? null);
    },

    async getMovie(movieId: string) {
      const movie = await repo.findMovie(pool, movieId);
      if (!movie) throw new NotFoundError('Movie not found');
      return movie;
    },

    /** A movie's shows in a city on a date, grouped by theatre. */
    async listShowsForMovie(movieId: string, citySlug: string, date: string | undefined) {
      if (!(await repo.findMovie(pool, movieId))) throw new NotFoundError('Movie not found');
      if (!(await repo.cityExists(pool, citySlug))) throw new NotFoundError('City not found');

      const rows = await repo.listShowsForMovie(pool, movieId, citySlug, date ?? null);
      const theatres = new Map<
        string,
        { id: string; name: string; address: string; shows: unknown[] }
      >();
      for (const row of rows) {
        let theatre = theatres.get(row.theatreId);
        if (!theatre) {
          theatre = { id: row.theatreId, name: row.theatreName, address: row.address, shows: [] };
          theatres.set(row.theatreId, theatre);
        }
        theatre.shows.push({
          id: row.showId,
          screen: row.screenName,
          startsAt: row.startsAt,
          availableSeats: row.availableSeats,
        });
      }
      return [...theatres.values()];
    },

    async getShow(showId: string) {
      const show = await repo.findShow(pool, showId);
      if (!show) throw new NotFoundError('Show not found');
      return show;
    },

    async getSeatMap(showId: string) {
      if (!(await repo.findShow(pool, showId))) throw new NotFoundError('Show not found');
      return repo.listSeatMap(pool, showId);
    },
  };
}

/**
 * Turns rows of seat counts into positioned seats. Each row is one grid line
 * (front row = y 0); an aisle after seat n leaves grid cell n empty.
 */
export function layoutToSeats(rows: CreateScreenInput['rows']): repo.SeatRow[] {
  return rows.flatMap((row, y) => {
    const aisles = new Set(row.aisleAfter);
    const seats: repo.SeatRow[] = [];
    let x = 0;
    for (let number = 1; number <= row.seats; number++) {
      seats.push({
        categoryId: row.categoryId,
        rowLabel: row.label,
        seatNumber: number,
        gridX: x,
        gridY: y,
      });
      x += aisles.has(number) ? 2 : 1;
    }
    return seats;
  });
}

function assertPricesMatchCategories(
  prices: CreateShowInput['prices'],
  screenCategoryIds: string[],
): void {
  const priced = new Set<string>(prices.map((p) => p.categoryId));
  const missing = screenCategoryIds.filter((id) => !priced.has(id));
  const extra = [...priced].filter((id) => !screenCategoryIds.includes(id));
  if (missing.length > 0 || extra.length > 0 || priced.size !== prices.length) {
    throw new AppError(
      400,
      'VALIDATION_FAILED',
      'Give exactly one price for each seat category on this screen',
      { missingCategoryIds: missing, unknownCategoryIds: extra },
    );
  }
}
