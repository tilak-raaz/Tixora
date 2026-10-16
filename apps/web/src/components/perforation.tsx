import { cn } from '@/lib/cn';

/**
 * The tear line across a ticket: a dashed rule with a notch at each end. The notches are painted
 * in the colour behind the ticket (the page by default), so put this inside an overflow-hidden card.
 */
export function Perforation({
  notchClassName = 'bg-surface',
  lineClassName = 'border-line',
  className,
}: {
  notchClassName?: string;
  /** The dashed line's colour, e.g. a light one where the tear crosses a coloured part. */
  lineClassName?: string;
  className?: string;
}) {
  return (
    <div aria-hidden className={cn('relative h-0', className)}>
      <span className={cn('absolute inset-x-4 -top-px border-t-2 border-dashed', lineClassName)} />
      <span className={cn('absolute -top-2.5 -left-2.5 size-5 rounded-full', notchClassName)} />
      <span className={cn('absolute -top-2.5 -right-2.5 size-5 rounded-full', notchClassName)} />
    </div>
  );
}
