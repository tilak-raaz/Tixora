import type { ReactNode } from 'react';
import { posterColour } from '@/lib/poster';

/**
 * The top half of a show's ticket, in the movie's poster colour, so the show page and the
 * checkout carry the look of the poster that led there. Sits above a <Perforation />.
 */
export function TicketHead({
  title,
  subtitle,
  badge,
  aside,
}: {
  title: string;
  subtitle: ReactNode;
  /** The rating, shown in a box like on the poster. */
  badge?: string;
  aside?: ReactNode;
}) {
  return (
    <div
      className="relative p-5 text-white sm:p-7"
      style={{ backgroundColor: posterColour(title) }}
    >
      <div aria-hidden className="pointer-events-none absolute inset-2 border border-white/20" />
      <div className="relative flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-4xl leading-[0.92] break-words uppercase sm:text-6xl">
            {title}
          </h1>
          <div className="mt-2 text-white/80">{subtitle}</div>
        </div>
        <div className="flex items-center gap-2">
          {aside}
          {badge && (
            <span className="border border-white/70 px-1.5 py-0.5 text-xs leading-none font-bold">
              {badge}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
