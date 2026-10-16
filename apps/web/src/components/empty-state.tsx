import type { ReactNode } from 'react';

/** What to show when a list is empty: what happened, and what to do next. */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-card border-2 border-dashed border-line px-6 py-10">
      <p className="font-display text-2xl uppercase">{title}</p>
      {children && <div className="max-w-md text-muted">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
