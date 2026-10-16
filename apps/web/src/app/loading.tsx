import { Container } from '@/components/container';
import { Skeleton } from '@/components/ui/skeleton';

/** Shown while a page's data loads. */
export default function Loading() {
  return (
    <Container className="flex flex-col gap-6 pt-8 sm:pt-12" aria-busy>
      <Skeleton className="h-24 w-2/3 sm:h-32" />
      <div className="flex gap-1.5">
        {Array.from({ length: 7 }, (_, i) => (
          <Skeleton key={i} className="h-[4.25rem] w-[4.5rem]" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-5 lg:grid-cols-4 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="aspect-[2/3] w-full rounded-card" />
        ))}
      </div>
    </Container>
  );
}
