'use client';

import { formatPaise } from '@bmt/shared';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { Perforation } from '@/components/perforation';
import { TicketHead } from '@/components/ticket-head';
import { Button, ButtonLink } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { useCountdown } from '@/hooks/use-countdown';
import { api, isApiError } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { getBooking, releaseHold, type Booking } from '@/lib/bookings';
import type { Show } from '@/lib/catalog';
import { cn } from '@/lib/cn';
import { formatCountdown } from '@/lib/countdown';
import { formatShowDate, formatTime } from '@/lib/format';
import {
  createPaymentOrder,
  openRazorpayCheckout,
  payFake,
  verifyPayment,
  type CheckoutSuccess,
  type PaymentOrder,
} from '@/lib/payments';
import { seatLabel } from '@/lib/seat-state';
import { SITE_NAME } from '@/lib/site';

type Loaded =
  | { kind: 'loading' }
  | { kind: 'ready'; booking: Booking; show: Show }
  | { kind: 'missing' }
  | { kind: 'failed'; message: string };

/**
 * paying: the order is being made or Checkout is open. confirming: the payment went through and
 * we wait for the webhook to confirm the booking. late: the hold ended before the payment arrived.
 * slow: confirmation is taking longer than we wait for.
 */
type PayState = 'idle' | 'paying' | 'confirming' | 'late' | 'slow';

/** The last minute is shown in red. */
const URGENT_MS = 60_000;
/** After paying, how long to wait for the webhook before saying it is taking a while. */
const CONFIRM_WAIT_MS = 30_000;
const CONFIRM_CHECK_MS = 1_000;

export function CheckoutView({ bookingId }: { bookingId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const { data: session } = authClient.useSession();
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [releasing, setReleasing] = useState(false);
  const [pay, setPay] = useState<PayState>('idle');
  const [fakeOrder, setFakeOrder] = useState<PaymentOrder | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const booking = await getBooking(bookingId);
        if (booking.status === 'CONFIRMED') {
          router.replace(`/bookings/${booking.id}`);
          return;
        }
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

  /**
   * The browser never confirms a booking: the webhook does (ADR 0007). After Checkout succeeds we
   * check the signature, then wait a short while for the booking to change.
   */
  const confirm = useCallback(
    async (success: CheckoutSuccess) => {
      setPay('confirming');
      try {
        await verifyPayment(bookingId, success);
      } catch (err) {
        // A bad signature means this browser did not see a real payment; the webhook still decides.
        if (!isApiError(err, 'PAYMENT_SIGNATURE_INVALID')) throw err;
      }
      const until = Date.now() + CONFIRM_WAIT_MS;
      while (Date.now() < until) {
        const current = await getBooking(bookingId).catch(() => undefined);
        if (current?.status === 'CONFIRMED') {
          toast({
            title: 'Booked',
            description: 'Your ticket is on its way by email.',
            tone: 'success',
          });
          router.replace(`/bookings/${bookingId}`);
          return;
        }
        if (current && current.status !== 'PENDING_PAYMENT') {
          setPay('late');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, CONFIRM_CHECK_MS));
      }
      setPay('slow');
    },
    [bookingId, router, toast],
  );

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
  const waiting = pay === 'confirming' || pay === 'late' || pay === 'slow';
  const active = b.status === 'PENDING_PAYMENT' && left > 0 && !waiting;
  const ended =
    !waiting && (b.status === 'EXPIRED' || (b.status === 'PENDING_PAYMENT' && left === 0));

  async function startPayment() {
    setPay('paying');
    let order: PaymentOrder;
    try {
      order = await createPaymentOrder(b.id);
    } catch (err) {
      setPay('idle');
      if (isApiError(err, 'HOLD_ENDING_SOON')) {
        toast({
          title: 'Less than a minute left on this hold',
          description: 'Not enough time to pay safely. Pick your seats again.',
          tone: 'error',
        });
      } else if (isApiError(err, 'RATE_LIMITED')) {
        toast({
          title: 'Too many attempts',
          description: `Try again in ${err.retryAfterSeconds ?? 60} seconds.`,
          tone: 'error',
        });
      } else {
        toast({
          title: 'Payment did not start',
          description: isApiError(err) ? err.message : 'Try again.',
          tone: 'error',
        });
      }
      return;
    }

    if (order.checkout === 'fake') {
      setFakeOrder(order);
      return;
    }

    try {
      const outcome = await openRazorpayCheckout(order, {
        name: SITE_NAME,
        description: `${show.movie.title}, ${b.seats.map(seatLabel).join(', ')}`,
        buyer: { name: session?.user.name, email: session?.user.email },
      });
      if (outcome.kind === 'paid') await confirm(outcome.success);
      else {
        setPay('idle');
        if (outcome.kind === 'failed') {
          toast({ title: 'Payment failed', description: outcome.reason, tone: 'error' });
        }
      }
    } catch {
      setPay('idle');
      toast({
        title: 'Payment did not finish',
        description:
          'If you paid, the booking appears in My bookings once it is confirmed. Otherwise try again.',
        tone: 'error',
      });
    }
  }

  async function finishFake(outcome: 'paid' | 'failed') {
    setFakeOrder(null);
    try {
      const success = await payFake(b.id, outcome);
      if (success) await confirm(success);
      else {
        setPay('idle');
        toast({
          title: 'Payment failed',
          description: 'Nothing was charged. Try again.',
          tone: 'error',
        });
      }
    } catch (err) {
      setPay('idle');
      toast({
        title: 'Payment did not go through',
        description: isApiError(err) ? err.message : 'Try again.',
        tone: 'error',
      });
    }
  }

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
            <div className="sm:text-right">
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
          <Button
            size="lg"
            onClick={startPayment}
            loading={pay === 'paying'}
            className="sm:min-w-56"
          >
            Pay {formatPaise(b.totalPaise)}
          </Button>
          <Button
            variant="secondary"
            size="lg"
            onClick={release}
            loading={releasing}
            disabled={pay === 'paying'}
          >
            Release seats
          </Button>
        </div>
      )}

      {pay === 'confirming' && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-card border-2 border-dashed border-line px-6 py-6"
        >
          <Spinner className="mt-1 size-5 text-primary" />
          <div>
            <p className="font-display text-2xl uppercase">Confirming your booking</p>
            <p className="mt-1 text-muted">
              Payment received. We are waiting for the payment provider to confirm it, which usually
              takes a few seconds. Keep this page open.
            </p>
          </div>
        </div>
      )}
      {pay === 'late' && (
        <EmptyState
          title="Your hold ended first"
          action={<ButtonLink href={`/shows/${b.showId}`}>Pick seats again</ButtonLink>}
        >
          The payment arrived after the seats were released, so they could not be booked. The full
          amount is refunded automatically, and an email with the details is on its way.
        </EmptyState>
      )}
      {pay === 'slow' && (
        <EmptyState
          title="Still confirming"
          action={<ButtonLink href="/bookings">Go to My bookings</ButtonLink>}
        >
          The payment provider has not confirmed the payment yet. It will appear in My bookings once
          it does, and you will get an email. If it never confirms, the money is refunded.
        </EmptyState>
      )}

      {ended && (
        <EmptyState
          title="Your hold ended"
          action={<ButtonLink href={`/shows/${b.showId}`}>Pick seats again</ButtonLink>}
        >
          The 5 minutes ran out, so these seats are free for everyone again. Nothing was charged.
        </EmptyState>
      )}
      {b.status === 'CANCELLED' && !waiting && (
        <EmptyState
          title="You released these seats"
          action={<ButtonLink href={`/shows/${b.showId}`}>Pick seats again</ButtonLink>}
        />
      )}

      <Sheet
        open={fakeOrder !== null}
        onClose={() => {
          setFakeOrder(null);
          setPay('idle');
        }}
        title="Test payment"
        footer={
          <>
            <Button variant="secondary" onClick={() => finishFake('failed')}>
              Fail payment
            </Button>
            <Button onClick={() => finishFake('paid')}>Pay {formatPaise(b.totalPaise)}</Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          Payments are simulated on this server (PAYMENT_GATEWAY=fake), so nothing is charged. The
          booking is still confirmed the real way: by a signed webhook a moment after you pay.
        </p>
      </Sheet>
    </>
  );
}
