import { cookies } from 'next/headers';
import { Container } from '@/components/container';
import { DateStrip } from '@/components/date-strip';
import { EmptyState } from '@/components/empty-state';
import { HeroTicket } from '@/components/hero-ticket';
import { MovieCard } from '@/components/movie-card';
import { getCities, getMoviesInCity } from '@/lib/catalog';
import { CITY_COOKIE_NAME, pickCity } from '@/lib/city';
import { dateHeadline, firstParam, isIsoDate, nextDays, todayIn } from '@/lib/format';

/** How many days ahead the date strip offers. The seed data covers a week. */
const DAYS_AHEAD = 7;

/** The listing's id: the hero's button scrolls to it. */
const LISTING_ID = 'showing';

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const cities = await getCities();
  const city = pickCity(
    cities,
    firstParam(params.city),
    (await cookies()).get(CITY_COOKIE_NAME)?.value,
  );

  if (!city) {
    return (
      <Container className="pt-10">
        <EmptyState title="No cities yet">
          Load the demo catalog with <code>make seed</code>, then refresh this page.
        </EmptyState>
      </Container>
    );
  }

  const today = todayIn(city.timezone);
  const dates = nextDays(today, DAYS_AHEAD);
  const requested = firstParam(params.date);
  const date = isIsoDate(requested) && dates.includes(requested) ? requested : today;
  const movies = await getMoviesInCity(city.slug, date);
  const query = (d: string) => `city=${encodeURIComponent(city.slug)}&date=${d}`;

  return (
    <Container className="flex flex-col gap-6 pt-6 sm:pt-10">
      <HeroTicket cityName={city.name} listingId={LISTING_ID} />

      <div
        id={LISTING_ID}
        className="mt-4 flex scroll-mt-20 flex-col gap-5 lg:flex-row lg:items-end lg:justify-between"
      >
        <div>
          <h2 className="font-display text-4xl leading-[0.9] uppercase sm:text-6xl">
            {dateHeadline(date, today)}
            <br />
            in {city.name}
          </h2>
          <p className="mt-3 text-muted">
            {movies.length === 1 ? '1 movie showing.' : `${movies.length} movies showing.`} Pick one
            to see times and seats.
          </p>
        </div>
        <DateStrip dates={dates} selected={date} today={today} hrefFor={(d) => `/?${query(d)}`} />
      </div>

      {movies.length === 0 ? (
        <EmptyState title="Nothing showing">
          No shows in {city.name} on this day. Pick another date above.
        </EmptyState>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-5 lg:grid-cols-4 xl:grid-cols-5">
          {movies.map((movie) => (
            <li key={movie.id}>
              <MovieCard movie={movie} href={`/movies/${movie.id}?${query(date)}`} />
            </li>
          ))}
        </ul>
      )}
    </Container>
  );
}
