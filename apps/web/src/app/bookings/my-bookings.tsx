'use client';

import { formatPaise } from '@bmt/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tag, type TagTone } from '@/components/ui/tag';
import { isApiError } from '@/lib/api';
import { groupBookings, listBookings, type BookingSummary } from '@/lib/bookings';
import { formatShowDate, formatTime } from '@/lib/format';
import { posterColour } from '@/lib/poster';

const STATUS: Record<BookingSummary['status'], { label: string; tone: TagTone }> = {
  CONFIRMED: { label: 'Booked', tone: 'success' },
  PENDING_PAYMENT: { label: 'Waiting for payment', tone: 'warning' },
  EXPIRED: { label: 'Hold ended', tone: 'neutral' },
  CANCELLED: { label: 'Released', tone: 'neutral' },
};

export function MyBookings() {
  const router = useRouter();
  const [bookings, setBookings] = useState<BookingSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    listBookings()
      .then(setBookings)
      .catch((err: unknown) => {
        if (isApiError(err, 'UNAUTHENTICATED')) router.replace('/login?next=%2Fbookings');
        else setFailed(true);
      });
  }, [router]);

  if (failed) {
    return <EmptyState title="Your bookings did not load">Try again in a moment.</EmptyState>;
  }
  if (!bookings) {
    return (
      <div className="flex flex-col gap-3" aria-busy>
        <Skeleton className="h-24 w-full rounded-card" />
        <Skeleton className="h-24 w-full rounded-card" />
      </div>
    );
  }
  if (bookings.length === 0) {
    return (
      <EmptyState title="No bookings yet" action={<ButtonLink href="/">See what is on</ButtonLink>}>
        Seats you hold or book show up here.
      </EmptyState>
    );
  }

  const groups = groupBookings(bookings);
  return (
    <div className="flex flex-col gap-10">
      <Group title="Waiting for payment" bookings={groups.awaitingPayment} />
      <Group title="Coming up" bookings={groups.upcoming} />
      <Group title="Watched" bookings={groups.past} />
      <Group title="Not booked" bookings={groups.ended} />
    </div>
  );
}

function Group({ title, bookings }: { title: string; bookings: BookingSummary[] }) {
  if (bookings.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-display text-2xl uppercase">{title}</h2>
      <ul className="grid gap-3 md:grid-cols-2">
        {bookings.map((booking) => (
          <li key={booking.id}>
            <BookingStub booking={booking} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One booking as a stub: a strip in the movie's poster colour, then what and when. */
function BookingStub({ booking }: { booking: BookingSummary }) {
  const status = STATUS[booking.status];
  const href =
    booking.status === 'CONFIRMED'
      ? `/bookings/${booking.id}`
      : booking.status === 'PENDING_PAYMENT'
        ? `/checkout/${booking.id}`
        : `/shows/${booking.showId}`;
  const muted = booking.status === 'EXPIRED' || booking.status === 'CANCELLED';

  return (
    <Link
      href={href}
      className="group flex overflow-hidden rounded-card bg-card transition-shadow hover:ring-2 hover:ring-ink"
    >
      <span
        aria-hidden
        className="w-3 shrink-0"
        style={{
          backgroundColor: muted ? 'var(--color-line)' : posterColour(booking.show.movieTitle),
        }}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-4">
        <div className="flex items-start justify-between gap-3">
          <p className="truncate font-semibold group-hover:text-primary">
            {booking.show.movieTitle}
          </p>
          <Tag tone={status.tone}>{status.label}</Tag>
        </div>
        <p className="text-sm">
          {formatShowDate(booking.show.startsAt, booking.show.timezone)},{' '}
          {formatTime(booking.show.startsAt, booking.show.timezone)}
        </p>
        <p className="text-sm text-muted">
          {booking.show.theatre}, {booking.show.screen}
        </p>
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="font-semibold">{booking.seats.join(', ')}</span>
          <span className="text-muted">{formatPaise(booking.totalPaise)}</span>
        </div>
      </div>
    </Link>
  );
}
