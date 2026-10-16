'use client';

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type ToastTone = 'default' | 'success' | 'error';

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
}

interface ToastItem extends ToastInput {
  id: number;
  tone: ToastTone;
}

const VISIBLE_MS = 4000;
const MAX_TOASTS = 3;

const ToastContext = createContext<((toast: ToastInput) => void) | null>(null);

/** The dot before the message carries the tone; the toast itself is always dark. */
const DOTS: Record<ToastTone, string> = {
  default: 'bg-white/60',
  success: 'bg-success-soft',
  error: 'bg-primary',
};

/** Short messages at the bottom of the screen, read out by screen readers. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(
    (input: ToastInput) => {
      nextId.current += 1;
      const id = nextId.current;
      setToasts((current) => [
        ...current.slice(-(MAX_TOASTS - 1)),
        { ...input, id, tone: input.tone ?? 'default' },
      ]);
      window.setTimeout(() => dismiss(id), VISIBLE_MS);
    },
    [dismiss],
  );

  return (
    <ToastContext value={show}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 pb-[env(safe-area-inset-bottom)]"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg bg-ink px-4 py-3 text-white"
          >
            <span
              aria-hidden
              className={cn('mt-1.5 size-2 shrink-0 rounded-full', DOTS[toast.tone])}
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{toast.title}</p>
              {toast.description && (
                <p className="mt-0.5 text-sm text-white/75">{toast.description}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              className="text-sm font-semibold text-white/75 hover:text-white"
            >
              Dismiss
            </button>
          </div>
        ))}
      </div>
    </ToastContext>
  );
}

/** Returns `toast({ title, description?, tone? })`. */
export function useToast(): (toast: ToastInput) => void {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error('useToast must be used inside <ToastProvider>');
  return toast;
}
