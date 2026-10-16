import { cn } from '@/lib/cn';

/** A grey placeholder shown while content loads. Size it with className. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn('rounded-md bg-line/70 motion-safe:animate-pulse', className)} />
  );
}
