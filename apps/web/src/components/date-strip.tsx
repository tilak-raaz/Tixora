import Link from 'next/link';
import { cn } from '@/lib/cn';
import { dateChip } from '@/lib/format';

interface DateStripProps {
  dates: string[];
  selected: string;
  today: string;
  hrefFor: (date: string) => string;
}

/** The week as a row of tear-off stubs; scrolls sideways on phones. */
export function DateStrip({ dates, selected, today, hrefFor }: DateStripProps) {
  return (
    <nav aria-label="Pick a date" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex gap-1.5 pb-1">
        {dates.map((date) => {
          const chip = dateChip(date, today);
          const active = date === selected;
          return (
            <li key={date}>
              <Link
                href={hrefFor(date)}
                scroll={false}
                aria-current={active ? 'date' : undefined}
                className={cn(
                  'ticket-stub flex w-[4.5rem] flex-col items-center py-2 transition-colors',
                  active ? 'bg-primary text-white' : 'bg-card text-ink hover:bg-primary-soft',
                )}
              >
                <span className={cn('text-xs', active ? 'text-white/80' : 'text-muted')}>
                  {chip.top}
                </span>
                <span className="font-display text-[1.75rem] leading-none">{chip.day}</span>
                <span className={cn('text-xs', active ? 'text-white/80' : 'text-muted')}>
                  {chip.month}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
