'use client';

import { formatPaise } from '@bmt/shared';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { Perforation } from '@/components/perforation';
import { TicketHead } from '@/components/ticket-head';
import { buttonClasses, ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, isApiError } from '@/lib/api';
import { getBooking, ticketReference, type Booking } from '@/lib/bookings';
import type { Show } from '@/lib/catalog';
import { formatDuration, formatShowDate, formatTime } from '@/lib/format';
import { seatLabel } from '@/lib/seat-state';

type Loaded =
  { kind: 'loading' } | { kind: 'ready'; booking: Booking; show: Show } | { kind: 'missing' };

/** A confirmed booking as a ticket, with the PDF (and its QR code) to download. */
export function TicketView({ bookingId }: { bookingId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const booking = await getBooking(bookingId);
        // Not paid for yet: the checkout is where that happens.
        if (booking.status === 'PENDING_PAYMENT') {
          router.replace(`/checkout/${booking.id}`);
          return;
        }
        const { show } = await api<{ show: Show }>(`/shows/${booking.showId}`);
        if (!cancelled) setLoaded({ kind: 'ready', booking, show });
      } catch (err) {
        if (cancelled) return;
        if (isApiError(err, 'UNAUTHENTICATED')) {
          router.replace(`/login?next=${encodeURIComponent(pathname)}`);
        } else {
          setLoaded({ kind: 'missing' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bookingId, pathname, router]);

  if (loaded.kind === 'loading') {
    return <Skeleton className="h-96 w-full rounded-card" />;
  }
  if (loaded.kind === 'missing') {
    return (
      <EmptyState
        title="Ticket not found"
        action={<ButtonLink href="/bookings">My bookings</ButtonLink>}
      >
        It may belong to another account.
      </EmptyState>
    );
  }

  const { booking, show } = loaded;
  if (booking.status !== 'CONFIRMED') {
    return (
      <EmptyState
        title="No ticket for this booking"
        action={<ButtonLink href={`/shows/${booking.showId}`}>Pick seats again</ButtonLink>}
      >
        {booking.status === 'CANCELLED'
          ? 'These seats were released before paying.'
          : 'The hold ended before it was paid for, so nothing was charged.'}
      </EmptyState>
    );
  }

  return (
    <>
      <section className="overflow-hidden rounded-card bg-card">
        <TicketHead
          title={show.movie.title}
          badge={show.movie.certificate}
          subtitle={`${show.theatre.name}, ${show.screen.name}`}
        />
        <Perforation lineClassName="border-transparent" />
        <dl className="grid grid-cols-2 gap-x-4 gap-y-5 p-5 sm:grid-cols-4 sm:p-7">
          <Detail label="Date" value={formatShowDate(show.startsAt, show.timezone)} />
          <Detail label="Starts" value={formatTime(show.startsAt, show.timezone)} />
          <Detail label="Runtime" value={formatDuration(show.movie.durationMin)} />
          <Detail label="Paid" value={formatPaise(booking.totalPaise)} />
        </dl>
        <Perforation />
        <div className="flex flex-wrap items-end justify-between gap-5 p-5 sm:p-7">
          <div>
            <p className="text-sm text-muted">Seats</p>
            <p className="font-display text-4xl leading-none uppercase">
              {booking.seats.map(seatLabel).join(' ')}
            </p>
          </div>
          <div className="text-right">
            <p className="text-sm text-muted">Booking reference</p>
            <p className="font-display text-4xl leading-none tracking-wide">
              {ticketReference(booking.id)}
            </p>
          </div>
        </div>
      </section>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <a
          href={`/api/v1/bookings/${booking.id}/ticket`}
          download
          className={buttonClasses('primary', 'lg', 'sm:min-w-56')}
        >
          Download ticket (PDF)
        </a>
        <ButtonLink href="/bookings" variant="secondary" size="lg">
          My bookings
        </ButtonLink>
      </div>
      <p className="text-sm text-muted">
        Show the QR code on the PDF at the entrance. The same ticket is in your email.
      </p>
    </>
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
