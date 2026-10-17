'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  /** The panel's accessible name, e.g. "Account". */
  label: string;
  children: ReactNode;
  className?: string;
}

/**
 * A full-height panel that slides in from the right. Built on <dialog> like Sheet, so focus is
 * trapped, Escape closes it and the page behind is inert; a click on the backdrop closes it too.
 */
export function Drawer({ open, onClose, label, children, className }: DrawerProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label={label}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        'm-0 ml-auto h-dvh max-h-none w-[min(22rem,88vw)] max-w-none bg-card p-0 text-ink',
        'backdrop:bg-ink/50 open:motion-safe:animate-drawer-in',
        className,
      )}
    >
      {children}
    </dialog>
  );
}
