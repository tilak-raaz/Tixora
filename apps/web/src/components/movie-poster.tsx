import { cn } from '@/lib/cn';
import { posterColour } from '@/lib/poster';

interface MoviePosterProps {
  title: string;
  posterUrl: string | null;
  language?: string;
  certificate?: string;
  className?: string;
}

/**
 * The movie's poster image, or a typographic one when the catalog has none (the seed data):
 * a flat colour, a thin frame, the rating in a box and the title set big in poster type.
 */
export function MoviePoster({
  title,
  posterUrl,
  language,
  certificate,
  className,
}: MoviePosterProps) {
  if (posterUrl) {
    return (
      // Poster hosts are not known in advance, so next/image's remote allow-list does not fit.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={posterUrl}
        alt={`${title} poster`}
        className={cn('aspect-[2/3] w-full object-cover', className)}
      />
    );
  }

  const long = title.length > 14;
  return (
    <div
      role="img"
      aria-label={`${title} poster`}
      className={cn('@container relative aspect-[2/3] w-full text-white', className)}
      style={{ backgroundColor: posterColour(title) }}
    >
      <div className="absolute inset-2 flex flex-col justify-between border border-white/25 p-3">
        <div className="flex justify-end">
          {certificate && (
            <span className="border border-white/70 px-1.5 py-0.5 text-[11px] leading-none font-bold">
              {certificate}
            </span>
          )}
        </div>
        <div>
          {language && (
            <p className="mb-1.5 text-[clamp(0.7rem,6cqw,0.875rem)] font-medium text-white/75">
              {language}
            </p>
          )}
          <p
            className={cn(
              'font-display leading-[0.92] break-words uppercase',
              // Sized to the poster's own width, so it fits a small card and a big banner alike.
              long ? 'text-[15cqw]' : 'text-[19cqw]',
            )}
          >
            {title}
          </p>
        </div>
      </div>
    </div>
  );
}
