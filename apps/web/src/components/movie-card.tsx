import Link from 'next/link';
import type { Movie } from '@/lib/catalog';
import { formatDuration } from '@/lib/format';
import { MoviePoster } from './movie-poster';
import { Perforation } from './perforation';
import { Tag } from './ui/tag';

/** A movie as a ticket: the poster, a tear line, and a stub with the title. */
export function MovieCard({ movie, href }: { movie: Movie; href: string }) {
  return (
    <Link href={href} className="group block overflow-hidden rounded-card bg-card">
      <MoviePoster
        title={movie.title}
        posterUrl={movie.posterUrl}
        language={movie.language}
        certificate={movie.certificate}
      />
      <Perforation />
      <div className="px-3.5 pt-3.5 pb-4">
        <h3 className="line-clamp-2 leading-snug font-semibold group-hover:text-primary">
          {movie.title}
        </h3>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Tag tone="info">{movie.language}</Tag>
          <span className="text-sm text-muted">{formatDuration(movie.durationMin)}</span>
        </div>
      </div>
    </Link>
  );
}
