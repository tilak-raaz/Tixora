import type { Metadata } from 'next';
import Link from 'next/link';
import { Container } from '@/components/container';
import { Perforation } from '@/components/perforation';
import { SeatPicker } from '@/components/seat-map/seat-picker';
import { TicketHead } from '@/components/ticket-head';
import { Tag } from '@/components/ui/tag';
import { getSeatMap, getShow, orNotFound } from '@/lib/catalog';
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
  const [show, seats] = await Promise.all([orNotFound(getShow(id)), getSeatMap(id)]);
  const cancelled = show.status === 'CANCELLED';
  const bookable = !cancelled && new Date(show.startsAt).getTime() > Date.now();

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
        <TicketHead
          title={show.movie.title}
          subtitle={`${show.theatre.name}, ${show.screen.name}`}
          badge={show.movie.certificate}
          aside={cancelled ? <Tag>Cancelled</Tag> : undefined}
        />
        <Perforation lineClassName="border-transparent" />
        <dl className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-4 sm:p-7">
          <Detail label="Date" value={formatShowDate(show.startsAt, show.timezone)} />
          <Detail label="Starts" value={formatTime(show.startsAt, show.timezone)} />
          <Detail label="Runtime" value={formatDuration(show.movie.durationMin)} />
          <Detail label="Language" value={show.movie.language} />
        </dl>
      </section>

      {bookable ? (
        <SeatPicker showId={show.id} initialSeats={seats} />
      ) : (
        <section className="rounded-card border-2 border-dashed border-line px-6 py-10">
          <p className="font-display text-2xl uppercase">Booking is closed</p>
          <p className="mt-1 text-muted">
            {cancelled ? 'This show was cancelled.' : 'This show has already started.'}
          </p>
        </section>
      )}
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
