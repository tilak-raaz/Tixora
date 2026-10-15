import type { Request } from 'express';
import type { z } from 'zod';

/**
 * Parse request input with a Zod schema inside a handler. On failure the
 * ZodError reaches the error middleware, which answers 400 VALIDATION_FAILED
 * with one entry per problem. The return value is fully typed.
 *
 *   const body = parseBody(createMovieSchema, req);
 */
export function parseBody<S extends z.ZodType>(schema: S, req: Request): z.output<S> {
  return schema.parse(req.body);
}

export function parseQuery<S extends z.ZodType>(schema: S, req: Request): z.output<S> {
  return schema.parse(req.query);
}

export function parseParams<S extends z.ZodType>(schema: S, req: Request): z.output<S> {
  return schema.parse(req.params);
}
