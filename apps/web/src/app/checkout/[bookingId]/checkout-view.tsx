'use client';

import { formatPaise } from '@bmt/shared';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { Perforation } from '@/components/perforation';
import { TicketHead } from '@/components/ticket-head';
import { Button, ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { useCountdown } from '@/hooks/use-countdown';
import { api, isApiError } from '@/lib/api';
import { getBooking, releaseHold, type Booking } from '@/lib/bookings';
import type { Show } from '@/lib/catalog';
import { cn } from '@/lib/cn';
import { formatCountdown } from '@/lib/countdown';
import { formatShowDate, formatTime } from '@/lib/format';
import { seatLabel } from '@/lib/seat-state';

type Loaded =
  | { kind: 'loading' }
  | { kind: 'ready'; booking: Booking; show: Show }
  | { kind: 'missing' }
  | { kind: 'failed'; message: string };

/** The last minute is shown in red. */
const URGENT_MS = 60_000;

export function CheckoutView({ bookingId }: { bookingId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [releasing, setReleasing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const booking = await getBooking(bookingId);
        const { show } = await api<{ show: Show }>(`/shows/${booking.showId}`);
        if (!cancelled) setLoaded({ kind: 'ready', booking, show });
      } catch (err) {
        if (cancelled) return;
        if (isApiError(err, 'UNAUTHENTICATED')) {
          router.replace(`/login?next=${encodeURIComponent(pathname)}`);
        } else if (isApiError(err, 'NOT_FOUND', 'VALIDATION_FAILED')) {
          setLoaded({ kind: 'missing' });
        } else {
          setLoaded({ kind: 'failed', message: isApiError(err) ? err.message : 'Try again.' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bookingId, pathname, router]);

  const booking = loaded.kind === 'ready' ? loaded.booking : undefined;
  const left = useCountdown(booking?.status === 'PENDING_PAYMENT' ? booking.expiresAt : undefined);

  if (loaded.kind === 'loading') {
    return (
      <div className="flex flex-col gap-4" aria-busy>
        <Skeleton className="h-64 w-full rounded-card" />
        <Skeleton className="h-12 w-40" />
      </div>
    );
  }
  if (loaded.kind === 'missing') {
    return (
      <EmptyState
        title="Booking not found"
        action={<ButtonLink href="/">See what is on</ButtonLink>}
      >
        It may belong to another account. Sign in with the account you booked with.
      </EmptyState>
    );
  }
  if (loaded.kind === 'failed') {
    return <EmptyState title="This booking did not load">{loaded.message}</EmptyState>;
  }

  const { show } = loaded;
  const b = loaded.booking;
  const active = b.status === 'PENDING_PAYMENT' && left > 0;
  const ended = b.status === 'EXPIRED' || (b.status === 'PENDING_PAYMENT' && left === 0);

  async function release() {
    setReleasing(true);
    try {
      await releaseHold(b.id);
      toast({ title: 'Seats released', description: 'They are free for everyone again.' });
      router.push(`/shows/${b.showId}`);
    } catch (err) {
      setReleasing(false);
      toast({
        title: 'Could not release the seats',
        description: isApiError(err) ? err.message : 'Try again.',
        tone: 'error',
      });
    }
  }

  return (
    <>
      <section className="overflow-hidden rounded-card bg-card">
        <TicketHead
          title={show.movie.title}
          badge={show.movie.certificate}
          subtitle={
            <>
              <p>
                {show.theatre.name}, {show.screen.name}
              </p>
              <p className="mt-1 font-semibold text-white">
                {formatShowDate(show.startsAt, show.timezone)},{' '}
                {formatTime(show.startsAt, show.timezone)}
              </p>
            </>
          }
        />
        <Perforation lineClassName="border-transparent" />
        <div className="grid gap-5 p-5 sm:grid-cols-[1fr_auto] sm:items-end sm:p-7">
          <div>
            <p className="text-sm text-muted">Seats</p>
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {b.seats.map((seat) => (
                <li
                  key={seat.id}
                  className="rounded bg-ink px-2 py-1 text-sm font-semibold text-white"
                  title={seat.category}
                >
                  {seatLabel(seat)}
                </li>
              ))}
            </ul>
            <p className="mt-4 text-sm text-muted">Total</p>
            <p className="font-display text-3xl">{formatPaise(b.totalPaise)}</p>
          </div>
          {active && (
            <div className="sm:text-right" aria-live="off">
              <p className="text-sm text-muted">Held for you for</p>
              <p
                className={cn(
                  'font-display text-6xl leading-none',
                  left <= URGENT_MS ? 'text-primary' : 'text-ink',
                )}
              >
                {formatCountdown(left)}
              </p>
              {/* Screen readers hear about the time only when it gets short. */}
              <p className="sr-only" aria-live="polite">
                {left <= URGENT_MS ? 'Less than a minute left to pay.' : ''}
              </p>
            </div>
          )}
        </div>
      </section>

      {active && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button size="lg" disabled className="sm:min-w-56">
            Pay {formatPaise(b.totalPaise)}
          </Button>
          <Button variant="secondary" size="lg" onClick={release} loading={releasing}>
            Release seats
          </Button>
          <p className="text-sm text-muted sm:ml-2">Payment opens here in the next update.</p>
        </div>
      )}

      {ended && (
        <EmptyState
          title="Your hold ended"
          action={<ButtonLink href={`/shows/${b.showId}`}>Pick seats again</ButtonLink>}
        >
          The 5 minutes ran out, so these seats are free for everyone again. Nothing was charged.
        </EmptyState>
      )}
      {b.status === 'CANCELLED' && (
        <EmptyState
          title="You released these seats"
          action={<ButtonLink href={`/shows/${b.showId}`}>Pick seats again</ButtonLink>}
        />
      )}
      {b.status === 'CONFIRMED' && (
        <EmptyState title="Booked">
          These seats are yours. Your ticket is on its way by email.
        </EmptyState>
      )}
    </>
  );
}
