import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { Container } from '@/components/container';
import { DateStrip } from '@/components/date-strip';
import { EmptyState } from '@/components/empty-state';
import { MoviePoster } from '@/components/movie-poster';
import { ButtonLink } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import {
  getCities,
  getMovie,
  getMovieShows,
  orNotFound,
  type ShowSummary,
  type TheatreShows,
} from '@/lib/catalog';
import { CITY_COOKIE_NAME, pickCity } from '@/lib/city';
import {
  dateHeadline,
  firstParam,
  formatCalendarDate,
  formatDuration,
  formatTime,
  isIsoDate,
  nextDays,
  todayIn,
} from '@/lib/format';

const DAYS_AHEAD = 7;
/** At or below this many free seats a show is marked as filling fast. */
const FEW_SEATS = 20;

interface MoviePageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: MoviePageProps): Promise<Metadata> {
  const { id } = await params;
  const movie = await orNotFound(getMovie(id));
  return { title: movie.title, description: movie.description ?? undefined };
}

export default async function MoviePage({ params, searchParams }: MoviePageProps) {
  const { id } = await params;
  const query = await searchParams;
  const [movie, cities] = await Promise.all([orNotFound(getMovie(id)), getCities()]);
  const city = pickCity(
    cities,
    firstParam(query.city),
    (await cookies()).get(CITY_COOKIE_NAME)?.value,
  );
  const released = movie.releaseDate <= todayIn(city?.timezone ?? 'Asia/Kolkata');

  return (
    <>
      <section className="bg-ink text-white">
        <Container className="grid gap-6 py-8 sm:grid-cols-[200px_1fr] sm:items-end sm:gap-10 sm:py-12">
          <div className="w-36 sm:w-full">
            <MoviePoster
              title={movie.title}
              posterUrl={movie.posterUrl}
              language={movie.language}
              certificate={movie.certificate}
              className="rounded-card ring-1 ring-white/15"
            />
          </div>
          <div className="flex flex-col items-start gap-4">
            <h1 className="font-display text-5xl leading-[0.92] uppercase sm:text-7xl">
              {movie.title}
            </h1>
            <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <Fact label="Language" value={movie.language} />
              <Fact label="Rated" value={movie.certificate} />
              <Fact label="Runtime" value={formatDuration(movie.durationMin)} />
              <Fact
                label={released ? 'Released' : 'Releases'}
                value={formatCalendarDate(movie.releaseDate)}
              />
            </dl>
            {movie.description && (
              <p className="max-w-prose leading-relaxed text-white/75">{movie.description}</p>
            )}
            {city && (
              <ButtonLink href="#shows" size="lg" className="mt-1">
                Book tickets
              </ButtonLink>
            )}
          </div>
        </Container>
      </section>

      <Container className="pt-8">
        {city ? (
          <Showtimes
            movieId={movie.id}
            citySlug={city.slug}
            cityName={city.name}
            timezone={city.timezone}
            requestedDate={firstParam(query.date)}
          />
        ) : (
          <EmptyState title="No cities yet">
            Load the demo catalog with <code>make seed</code>.
          </EmptyState>
        )}
      </Container>
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-white/55">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}

async function Showtimes({
  movieId,
  citySlug,
  cityName,
  timezone,
  requestedDate,
}: {
  movieId: string;
  citySlug: string;
  cityName: string;
  timezone: string;
  requestedDate: string | undefined;
}) {
  const today = todayIn(timezone);
  const dates = nextDays(today, DAYS_AHEAD);
  const date = isIsoDate(requestedDate) && dates.includes(requestedDate) ? requestedDate : today;
  const theatres = await getMovieShows(movieId, citySlug, date);

  return (
    <section
      id="shows"
      aria-labelledby="shows-heading"
      className="flex scroll-mt-20 flex-col gap-5"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <h2 id="shows-heading" className="font-display text-4xl leading-none uppercase">
          {dateHeadline(date, today)} in {cityName}
        </h2>
        <DateStrip
          dates={dates}
          selected={date}
          today={today}
          hrefFor={(d) => `/movies/${movieId}?city=${encodeURIComponent(citySlug)}&date=${d}`}
        />
      </div>

      {theatres.length === 0 ? (
        <EmptyState title="No shows this day">Pick another date above.</EmptyState>
      ) : (
        <>
          <ul className="flex flex-col">
            {theatres.map((theatre) => (
              <li
                key={theatre.id}
                className="border-t border-line py-5 first:border-t-0 first:pt-0"
              >
                <TheatreRow theatre={theatre} timezone={timezone} />
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted">
            Times are local to {cityName}. Amber times have {FEW_SEATS} seats or fewer left.
          </p>
        </>
      )}
    </section>
  );
}

function TheatreRow({ theatre, timezone }: { theatre: TheatreShows; timezone: string }) {
  return (
    <article className="grid gap-4 md:grid-cols-[260px_1fr]">
      <div>
        <h3 className="font-semibold">{theatre.name}</h3>
        <p className="mt-0.5 text-sm text-muted">{theatre.address}</p>
      </div>
      <ul className="flex flex-wrap gap-2">
        {theatre.shows.map((show) => (
          <li key={show.id}>
            <ShowStub show={show} timezone={timezone} />
          </li>
        ))}
      </ul>
    </article>
  );
}

/** A show time as a tear-off stub. */
function ShowStub({ show, timezone }: { show: ShowSummary; timezone: string }) {
  const time = formatTime(show.startsAt, timezone);
  const base = 'ticket-stub flex min-w-28 flex-col items-center px-5 py-2.5';

  if (show.availableSeats === 0) {
    return (
      <span className={cn(base, 'bg-hatch text-muted')}>
        <span className="font-semibold line-through">{time}</span>
        <span className="text-xs">Sold out</span>
      </span>
    );
  }

  const few = show.availableSeats <= FEW_SEATS;
  return (
    <Link
      href={`/shows/${show.id}`}
      className={cn(base, 'group bg-card transition-colors hover:bg-primary hover:text-white')}
    >
      <span className={cn('font-semibold', few && 'text-warning group-hover:text-white')}>
        {time}
      </span>
      <span className="text-xs text-muted group-hover:text-white/80">
        {few ? `${show.availableSeats} left` : show.screen}
      </span>
    </Link>
  );
}
