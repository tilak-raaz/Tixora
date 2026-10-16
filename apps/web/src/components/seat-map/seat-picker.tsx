'use client';

import { formatPaise } from '@bmt/shared';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, ButtonLink } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { useLiveSeats, type LiveStatus } from '@/hooks/use-live-seats';
import { isApiError } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { holdSeats, lastHoldKey, pendingSelectionKey } from '@/lib/bookings';
import { cn } from '@/lib/cn';
import { seatLabel, type Seat } from '@/lib/seat-state';
import { SeatMap } from './seat-map';

/** The API's default; it refuses more with a 400 anyway. */
export const MAX_SEATS = 5;

function readStorage(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    // Private mode or storage disabled: only the conveniences are lost.
  }
}

export function SeatPicker({ showId, initialSeats }: { showId: string; initialSeats: Seat[] }) {
  const router = useRouter();
  const toast = useToast();
  const { data: session } = authClient.useSession();
  const { seats, changed, status, reload } = useLiveSeats(showId, initialSeats);
  const [selected, setSelected] = useState<string[]>([]);
  const [holding, setHolding] = useState(false);
  const [existingHold, setExistingHold] = useState<string | null | undefined>(undefined);
  // One key per selection, so retrying the same seats after a network error cannot hold twice.
  const attempt = useRef<{ seats: string; key: string } | null>(null);
  // Seats in a hold request right now. Our own hold's event can arrive before its response, and
  // must not read as someone else taking them.
  const ours = useRef<ReadonlySet<string>>(new Set());

  // Seats picked before signing in come back, if they are still free.
  useEffect(() => {
    const saved = readStorage(pendingSelectionKey(showId));
    if (!saved) return;
    writeStorage(pendingSelectionKey(showId), null);
    const ids = (JSON.parse(saved) as string[]).filter(
      (id) => seats.get(id)?.status === 'AVAILABLE',
    );
    setSelected(ids.slice(0, MAX_SEATS));
    // Only on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showId]);

  // Someone else took a seat we had picked: drop it and say so.
  useEffect(() => {
    const lost = selected.filter(
      (id) => seats.get(id)?.status === 'UNAVAILABLE' && !ours.current.has(id),
    );
    if (lost.length === 0) return;
    setSelected((current) => current.filter((id) => !lost.includes(id)));
    const labels = lost.map((id) => seatLabel(seats.get(id)!)).join(', ');
    toast({
      title: lost.length === 1 ? `${labels} was just taken` : `${labels} were just taken`,
      description: 'Pick another seat.',
      tone: 'error',
    });
  }, [seats, selected, toast]);

  const chosen = useMemo(
    () => selected.map((id) => seats.get(id)).filter((seat): seat is Seat => Boolean(seat)),
    [selected, seats],
  );
  const total = chosen.reduce((sum, seat) => sum + seat.pricePaise, 0);

  function toggle(seat: Seat) {
    setExistingHold(undefined);
    setSelected((current) => {
      if (current.includes(seat.id)) return current.filter((id) => id !== seat.id);
      if (current.length >= MAX_SEATS) {
        toast({ title: `Up to ${MAX_SEATS} seats per booking` });
        return current;
      }
      return [...current, seat.id];
    });
  }

  async function hold() {
    if (!session) {
      writeStorage(pendingSelectionKey(showId), JSON.stringify(selected));
      router.push(`/login?next=${encodeURIComponent(`/shows/${showId}`)}`);
      return;
    }
    const signature = [...selected].sort().join(',');
    if (attempt.current?.seats !== signature) {
      attempt.current = { seats: signature, key: crypto.randomUUID() };
    }

    setHolding(true);
    ours.current = new Set(selected);
    try {
      const booking = await holdSeats(showId, selected, attempt.current.key);
      writeStorage(lastHoldKey(showId), booking.id);
      router.push(`/checkout/${booking.id}`);
      return; // keep the button busy while the next page loads
    } catch (err) {
      ours.current = new Set();
      if (isApiError(err, 'SEATS_UNAVAILABLE')) {
        const ids = (err.details as { unavailableSeatIds?: string[] } | undefined)
          ?.unavailableSeatIds;
        const labels = (ids ?? [])
          .map((id) => seats.get(id))
          .filter((seat): seat is Seat => Boolean(seat))
          .map(seatLabel);
        setSelected((current) => current.filter((id) => !ids?.includes(id)));
        toast({
          title: labels.length > 0 ? `${labels.join(', ')} just went` : 'Some seats just went',
          description: 'Someone else got there first. Pick other seats.',
          tone: 'error',
        });
        void reload();
      } else if (isApiError(err, 'ACTIVE_HOLD_EXISTS')) {
        setExistingHold(readStorage(lastHoldKey(showId)));
      } else if (isApiError(err, 'RATE_LIMITED')) {
        toast({
          title: 'Too many attempts',
          description: `Try again in ${err.retryAfterSeconds ?? 60} seconds.`,
          tone: 'error',
        });
      } else if (isApiError(err, 'UNAUTHENTICATED')) {
        writeStorage(pendingSelectionKey(showId), JSON.stringify(selected));
        router.push(`/login?next=${encodeURIComponent(`/shows/${showId}`)}`);
      } else {
        toast({
          title: 'Could not hold these seats',
          description: isApiError(err) ? err.message : 'Try again.',
          tone: 'error',
        });
      }
    }
    setHolding(false);
  }

  return (
    <section aria-labelledby="seats-heading" className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="seats-heading" className="font-display text-2xl uppercase">
          Pick your seats
        </h2>
        <LiveIndicator status={status} onRetry={reload} />
      </div>

      <div className="rounded-card bg-card px-4 py-6 sm:px-8">
        <SeatMap seats={seats} selected={new Set(selected)} changed={changed} onToggle={toggle} />
        <Legend />
      </div>

      <div
        className={cn(
          'sticky bottom-0 z-20 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t border-line bg-card px-4 py-3',
          'sm:static sm:mx-0 sm:rounded-card sm:border-t-0 sm:px-6 sm:py-4',
        )}
      >
        {existingHold !== undefined ? (
          <>
            <p className="text-sm">You already have seats on hold for this show.</p>
            {existingHold ? (
              <ButtonLink href={`/checkout/${existingHold}`}>Go to your seats</ButtonLink>
            ) : (
              <p className="text-sm text-muted">Release them or let the hold run out first.</p>
            )}
          </>
        ) : chosen.length === 0 ? (
          <p className="text-sm text-muted">Tap a seat to pick it. Up to {MAX_SEATS} seats.</p>
        ) : (
          <>
            <div>
              <p className="font-semibold">
                {chosen.length === 1 ? '1 seat' : `${chosen.length} seats`}:{' '}
                {chosen.map(seatLabel).join(', ')}
              </p>
              <p className="text-sm text-muted">
                {formatPaise(total)}, held for 5 minutes while you pay
              </p>
            </div>
            <Button size="lg" onClick={hold} loading={holding}>
              Hold seats
            </Button>
          </>
        )}
      </div>
    </section>
  );
}

function Legend() {
  const items = [
    ['Available', 'bg-card ring-1 ring-line ring-inset'],
    ['Selected', 'bg-ink'],
    ['Taken', 'bg-hatch'],
  ] as const;
  return (
    <ul className="mt-6 flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm text-muted">
      {items.map(([label, look]) => (
        <li key={label} className="flex items-center gap-2">
          <span aria-hidden className={cn('size-4 rounded-t-[5px] rounded-b-[2px]', look)} />
          {label}
        </li>
      ))}
    </ul>
  );
}

const STATUS_TEXT: Record<LiveStatus, string> = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  offline: 'Live updates paused',
};

/** Whether the map is following changes as they happen. */
function LiveIndicator({ status, onRetry }: { status: LiveStatus; onRetry: () => void }) {
  return (
    <p className="flex items-center gap-2 text-sm" aria-live="polite">
      <span
        aria-hidden
        className={cn(
          'size-2 rounded-full',
          status === 'live' ? 'bg-success' : status === 'offline' ? 'bg-muted' : 'bg-warning',
        )}
      />
      <span className={status === 'live' ? 'text-success' : 'text-muted'}>
        {STATUS_TEXT[status]}
      </span>
      {status === 'offline' && (
        <button
          type="button"
          onClick={onRetry}
          className="font-semibold text-ink underline underline-offset-2"
        >
          Refresh seats
        </button>
      )}
    </p>
  );
}
