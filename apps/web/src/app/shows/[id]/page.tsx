import { formatPaise } from '@bmt/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Container } from '@/components/container';
import { Perforation } from '@/components/perforation';
import { Tag } from '@/components/ui/tag';
import { getShow, orNotFound } from '@/lib/catalog';
import { formatDuration, formatShowDate, formatTime } from '@/lib/format';

interface ShowPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: ShowPageProps): Promise<Metadata> {
  const { id } = await params;
  const show = await orNotFound(getShow(id));
  return { title: `${show.movie.title}, ${formatTime(show.startsAt, show.timezone)}` };
}

export default async function ShowPage({ params }: ShowPageProps) {
  const { id } = await params;
  const show = await orNotFound(getShow(id));
  const cancelled = show.status === 'CANCELLED';

  return (
    <Container className="flex flex-col gap-6 pt-6 sm:pt-10">
      <Link
        href={`/movies/${show.movie.id}`}
        className="self-start text-sm font-semibold text-muted hover:text-ink"
      >
        Back to {show.movie.title}
      </Link>

      {/* The show as one ticket: what and where above the tear, when below it. */}
      <section className="overflow-hidden rounded-card bg-card">
        <div className="flex flex-wrap items-start justify-between gap-3 p-5 sm:p-7">
          <div>
            <h1 className="font-display text-4xl leading-[0.92] uppercase sm:text-6xl">
              {show.movie.title}
            </h1>
            <p className="mt-2 text-muted">
              {show.theatre.name}, {show.screen.name}
            </p>
          </div>
          {cancelled && <Tag tone="primary">Cancelled</Tag>}
        </div>
        <Perforation />
        <dl className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-4 sm:p-7">
          <Detail label="Date" value={formatShowDate(show.startsAt, show.timezone)} />
          <Detail label="Starts" value={formatTime(show.startsAt, show.timezone)} />
          <Detail label="Runtime" value={formatDuration(show.movie.durationMin)} />
          <Detail label="Language" value={show.movie.language} />
        </dl>
      </section>

      {show.prices && show.prices.length > 0 && (
        <section aria-labelledby="prices" className="flex flex-col gap-3">
          <h2 id="prices" className="font-display text-2xl uppercase">
            Prices
          </h2>
          <ul className="flex flex-wrap gap-2">
            {show.prices.map((price) => (
              <li
                key={price.categoryId}
                className="ticket-stub flex min-w-32 flex-col items-center bg-card px-6 py-3"
              >
                <span className="text-sm text-muted">{price.category}</span>
                <span className="font-semibold">{formatPaise(price.pricePaise)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Replaced by the live seat map in the next PR. */}
      <section className="rounded-card border-2 border-dashed border-line px-6 py-12 text-center text-muted">
        Seat selection for this show opens here soon.
      </section>
    </Container>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="mt-0.5 font-semibold">{value}</dd>
    </div>
  );
}
