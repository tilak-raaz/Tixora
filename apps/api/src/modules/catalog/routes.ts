import type { Pool } from '@bmt/platform';
import { Router } from 'express';
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

/** Public browsing: no sign-in needed. Mounted at /api/v1. */
export function catalogRouter(deps: { pool: Pool; limits?: RouteLimits }): Router {
  const catalog = createCatalogService(deps.pool);
  const router = Router();
  const browse = (deps.limits ?? NO_LIMITS).browse;

  router.get('/cities', browse, async (_req, res) => {
    res.json({ cities: await catalog.listCities() });
  });

  router.get('/cities/:slug/movies', browse, async (req, res) => {
    const { slug } = parseParams(slugParam, req);
    const { date } = parseQuery(dateQuery, req);
    res.json({ movies: await catalog.listMoviesInCity(slug, date) });
  });

  router.get('/movies/:id', browse, async (req, res) => {
    const { id } = parseParams(idParam, req);
    res.json({ movie: await catalog.getMovie(id) });
  });

  router.get('/movies/:id/shows', browse, async (req, res) => {
    const { id } = parseParams(idParam, req);
    const { city, date } = parseQuery(movieShowsQuery, req);
    res.json({ theatres: await catalog.listShowsForMovie(id, city, date) });
  });

  router.get('/shows/:id', browse, async (req, res) => {
    const { id } = parseParams(idParam, req);
    res.json({ show: await catalog.getShow(id) });
  });

  router.get('/shows/:id/seats', browse, async (req, res) => {
    const { id } = parseParams(idParam, req);
    res.json({ seats: await catalog.getSeatMap(id) });
  });

  return router;
}

/** Catalog management for admins. Mounted at /api/v1/admin. */
export function adminCatalogRouter(deps: { pool: Pool; auth: Auth }): Router {
  const catalog = createCatalogService(deps.pool);
  const router = Router();

  router.use(requireAuth(deps.auth), requireRole('admin'));

  router.post('/cities', async (req, res) => {
    res.status(201).json({ city: await catalog.createCity(parseBody(createCitySchema, req)) });
  });

  router.post('/seat-categories', async (req, res) => {
    const input = parseBody(createSeatCategorySchema, req);
    res.status(201).json({ seatCategory: await catalog.createSeatCategory(input) });
  });

  router.post('/theatres', async (req, res) => {
    const input = parseBody(createTheatreSchema, req);
    res.status(201).json({ theatre: await catalog.createTheatre(input) });
  });

  router.post('/screens', async (req, res) => {
    const input = parseBody(createScreenSchema, req);
    res.status(201).json({ screen: await catalog.createScreen(input) });
  });

  router.post('/movies', async (req, res) => {
    const input = parseBody(createMovieSchema, req);
    res.status(201).json({ movie: await catalog.createMovie(input) });
  });

  router.post('/shows', async (req, res) => {
    const input = parseBody(createShowSchema, req);
    res.status(201).json({ show: await catalog.createShow(input) });
  });

  return router;
}
