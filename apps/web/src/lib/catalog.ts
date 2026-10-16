import { notFound } from 'next/navigation';
import { cache } from 'react';
import { isApiError } from './api';
import { serverApi } from './server-api';

/** Response shapes of the public catalog endpoints (apps/api/src/modules/catalog). */
export interface City {
  id: string;
  name: string;
  slug: string;
  state: string;
  timezone: string;
}

export interface Movie {
  id: string;
  title: string;
  language: string;
  durationMin: number;
  certificate: string;
  releaseDate: string;
  description: string | null;
  posterUrl: string | null;
}

export interface ShowSummary {
  id: string;
  screen: string;
  startsAt: string;
  availableSeats: number;
}

export interface TheatreShows {
  id: string;
  name: string;
  address: string;
  shows: ShowSummary[];
}

export interface Show {
  id: string;
  status: 'SCHEDULED' | 'CANCELLED';
  startsAt: string;
  endsAt: string;
  movie: Pick<Movie, 'id' | 'title' | 'language' | 'durationMin' | 'certificate'>;
  theatre: { id: string; name: string; address: string };
  screen: { id: string; name: string };
  timezone: string;
  prices: { categoryId: string; category: string; pricePaise: number }[] | null;
}

// cache() shares one request between a page and its generateMetadata.
export const getCities = cache(async () => {
  const { cities } = await serverApi<{ cities: City[] }>('/cities');
  return cities;
});

export async function getMoviesInCity(citySlug: string, date: string): Promise<Movie[]> {
  const query = new URLSearchParams({ date });
  const { movies } = await serverApi<{ movies: Movie[] }>(
    `/cities/${encodeURIComponent(citySlug)}/movies?${query}`,
  );
  return movies;
}

export const getMovie = cache(async (id: string) => {
  const { movie } = await serverApi<{ movie: Movie }>(`/movies/${encodeURIComponent(id)}`);
  return movie;
});

export async function getMovieShows(
  movieId: string,
  citySlug: string,
  date: string,
): Promise<TheatreShows[]> {
  const query = new URLSearchParams({ city: citySlug, date });
  const { theatres } = await serverApi<{ theatres: TheatreShows[] }>(
    `/movies/${encodeURIComponent(movieId)}/shows?${query}`,
  );
  return theatres;
}

export const getShow = cache(async (id: string) => {
  const { show } = await serverApi<{ show: Show }>(`/shows/${encodeURIComponent(id)}`);
  return show;
});

/** Shows the 404 page when the API says the thing does not exist (or the id is malformed). */
export async function orNotFound<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    if (isApiError(err, 'NOT_FOUND', 'VALIDATION_FAILED')) notFound();
    throw err;
  }
}
