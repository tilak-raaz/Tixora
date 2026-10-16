import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type TagTone = 'neutral' | 'primary' | 'info' | 'success' | 'warning';

const TONES: Record<TagTone, string> = {
  neutral: 'bg-surface text-ink',
  primary: 'bg-primary-soft text-primary',
  info: 'bg-info-soft text-info',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
};

/** A small rounded label: a format, a language, a booking status. */
export function Tag({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: TagTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
