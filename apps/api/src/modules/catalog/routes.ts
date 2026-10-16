import type { Pool } from '@bmt/platform';
import { Router, type Response } from 'express';
import { NO_CACHE, type Cache } from '../../lib/cache';
import { NO_LIMITS, type RouteLimits } from '../../lib/rate-limit';
import { parseBody, parseParams, parseQuery } from '../../lib/validate';
import type { Auth } from '../auth/auth';
import { requireAuth, requireRole } from '../auth/middleware';
import {
  createCitySchema,
  createMovieSchema,
  createScreenSchema,
  createSeatCategorySchema,
  createShowSchema,
  createTheatreSchema,
  dateQuery,
  idParam,
  movieShowsQuery,
  slugParam,
} from './schemas';
import { createCatalogService } from './service';

/** The cache namespace for everything an admin write can change. */
export const CATALOG_CACHE = 'catalog';

/**
 * Public browsing: no sign-in needed. Mounted at /api/v1.
 *
 * Catalog reads go through the cache (60 s, cleared by any admin write); the
 * X-Cache header says HIT, MISS or BYPASS. The seat map is never cached: a
 * stale one would show taken seats as free and turn into failed holds.
 */
export function catalogRouter(deps: { pool: Pool; limits?: RouteLimits; cache?: Cache }): Router {
  const catalog = createCatalogService(deps.pool);
  const cache = deps.cache ?? NO_CACHE;
  const router = Router();
  const browse = (deps.limits ?? NO_LIMITS).browse;

  /** Sends `{ [field]: value }`, loading it through the catalog cache. */
  async function cached<T>(
    res: Response,
    key: string,
    field: string,
    load: () => Promise<T>,
  ): Promise<void> {
    const { value, outcome } = await cache.getOrLoad(CATALOG_CACHE, key, load);
    res.set('X-Cache', outcome).json({ [field]: value });
  }

  router.get('/cities', browse, async (_req, res) => {
    await cached(res, 'cities', 'cities', () => catalog.listCities());
  });

  router.get('/cities/:slug/movies', browse, async (req, res) => {
    const { slug } = parseParams(slugParam, req);
    const { date } = parseQuery(dateQuery, req);
    await cached(res, `city:${slug}:movies:${date ?? 'today'}`, 'movies', () =>
      catalog.listMoviesInCity(slug, date),
    );
  });

  router.get('/movies/:id', browse, async (req, res) => {
    const { id } = parseParams(idParam, req);
    await cached(res, `movie:${id}`, 'movie', () => catalog.getMovie(id));
  });

  router.get('/movies/:id/shows', browse, async (req, res) => {
    const { id } = parseParams(idParam, req);
    const { city, date } = parseQuery(movieShowsQuery, req);
    // Includes free-seat counts, so they can be up to 60 s old; the seat map is exact.
    await cached(res, `movie:${id}:shows:${city}:${date ?? 'today'}`, 'theatres', () =>
      catalog.listShowsForMovie(id, city, date),
    );
  });

  router.get('/shows/:id', browse, async (req, res) => {
    const { id } = parseParams(idParam, req);
    await cached(res, `show:${id}`, 'show', () => catalog.getShow(id));
  });

  router.get('/shows/:id/seats', browse, async (req, res) => {
    const { id } = parseParams(idParam, req);
    res.json({ seats: await catalog.getSeatMap(id) });
  });

  return router;
}

/** Catalog management for admins. Mounted at /api/v1/admin. */
export function adminCatalogRouter(deps: { pool: Pool; auth: Auth; cache?: Cache }): Router {
  const catalog = createCatalogService(deps.pool);
  const cache = deps.cache ?? NO_CACHE;
  const router = Router();
  /** Every write clears the public catalog cache before answering, so the admin's next read is fresh. */
  const changed = () => cache.invalidate(CATALOG_CACHE);

  router.use(requireAuth(deps.auth), requireRole('admin'));

  router.post('/cities', async (req, res) => {
    const created = await catalog.createCity(parseBody(createCitySchema, req));
    await changed();
    res.status(201).json({ city: created });
  });

  router.post('/seat-categories', async (req, res) => {
    const input = parseBody(createSeatCategorySchema, req);
    const created = await catalog.createSeatCategory(input);
    await changed();
    res.status(201).json({ seatCategory: created });
  });

  router.post('/theatres', async (req, res) => {
    const input = parseBody(createTheatreSchema, req);
    const created = await catalog.createTheatre(input);
    await changed();
    res.status(201).json({ theatre: created });
  });

  router.post('/screens', async (req, res) => {
    const input = parseBody(createScreenSchema, req);
    const created = await catalog.createScreen(input);
    await changed();
    res.status(201).json({ screen: created });
  });

  router.post('/movies', async (req, res) => {
    const input = parseBody(createMovieSchema, req);
    const created = await catalog.createMovie(input);
    await changed();
    res.status(201).json({ movie: created });
  });

  router.post('/shows', async (req, res) => {
    const input = parseBody(createShowSchema, req);
    const created = await catalog.createShow(input);
    await changed();
    res.status(201).json({ show: created });
  });

  return router;
}
