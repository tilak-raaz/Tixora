'use client';

import { formatPaise } from '@bmt/shared';
import { cn } from '@/lib/cn';
import { seatLabel, seatRows, type Seat } from '@/lib/seat-state';

interface SeatMapProps {
  seats: Map<string, Seat>;
  selected: ReadonlySet<string>;
  /** Seats an event just changed: they flash once. */
  changed: ReadonlySet<string>;
  onToggle: (seat: Seat) => void;
}

/** The auditorium: screen at the top, front row first, a price heading where the category changes. */
export function SeatMap({ seats, selected, changed, onToggle }: SeatMapProps) {
  const rows = seatRows(seats.values());

  return (
    <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
      <div className="mx-auto flex w-max flex-col items-center gap-1.5">
        <div aria-hidden className="mb-6 flex w-full flex-col items-center gap-1.5">
          <div className="h-2 w-[85%] rounded-[50%] border-t-4 border-ink/25" />
          <span className="text-xs text-muted">Screen</span>
        </div>

        {rows.map((row, index) => {
          const firstOfCategory = index === 0 || rows[index - 1]!.category !== row.category;
          const price = row.cells.find((cell) => cell)?.pricePaise;
          return (
            <div key={row.y} className="flex w-full flex-col items-center gap-1.5">
              {firstOfCategory && (
                <p className="mt-3 mb-1 w-full border-b border-line pb-1 text-left text-sm text-muted first:mt-0">
                  <span className="font-semibold text-ink">{row.category}</span>
                  {price !== undefined && <span className="ml-2">{formatPaise(price)}</span>}
                </p>
              )}
              <div className="flex items-center gap-1 sm:gap-1.5">
                <span className="w-6 text-center text-xs font-semibold text-muted">
                  {row.label}
                </span>
                {row.cells.map((seat, x) =>
                  seat ? (
                    <SeatButton
                      key={seat.id}
                      seat={seat}
                      selected={selected.has(seat.id)}
                      flash={changed.has(seat.id)}
                      onToggle={onToggle}
                    />
                  ) : (
                    <span key={`gap-${x}`} aria-hidden className="size-7 sm:size-8" />
                  ),
                )}
                <span className="w-6" aria-hidden />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SeatButton({
  seat,
  selected,
  flash,
  onToggle,
}: {
  seat: Seat;
  selected: boolean;
  flash: boolean;
  onToggle: (seat: Seat) => void;
}) {
  const taken = seat.status === 'UNAVAILABLE';
  return (
    <button
      type="button"
      disabled={taken}
      aria-pressed={selected}
      aria-label={`${seatLabel(seat)}, ${seat.category}, ${formatPaise(seat.pricePaise)}${taken ? ', taken' : ''}`}
      onClick={() => onToggle(seat)}
      className={cn(
        'relative flex size-7 items-center justify-center rounded-t-md rounded-b-sm text-[10px] font-semibold transition-colors sm:size-8 sm:text-xs',
        taken
          ? 'cursor-not-allowed bg-hatch text-transparent'
          : selected
            ? 'bg-ink text-white'
            : 'bg-card text-muted ring-1 ring-line ring-inset hover:text-ink hover:ring-ink',
      )}
    >
      {seat.number}
      {flash && taken && (
        <span
          key={seat.version}
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[inherit] motion-safe:animate-seat-taken"
        />
      )}
    </button>
  );
}
