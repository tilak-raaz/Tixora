'use client';

import { useEffect, useState } from 'react';
import { remainingMs } from '@/lib/countdown';

/**
 * Milliseconds left until `expiresAt`, re-rendering a few times a second. Read from the clock on
 * every render, so the first render after `expiresAt` arrives is already right.
 */
export function useCountdown(expiresAt: string | undefined): number {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setInterval(() => {
      setTick((tick) => tick + 1);
      if (remainingMs(expiresAt) === 0) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  return expiresAt ? remainingMs(expiresAt) : 0;
}
