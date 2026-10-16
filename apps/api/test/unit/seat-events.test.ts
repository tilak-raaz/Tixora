import { seatEventChannel, showIdFromChannel } from '@bmt/platform';
import { describe, expect, it } from 'vitest';
import { createStreamLimiter } from '../../src/modules/live/stream-limits';

describe('seat event channels', () => {
  it('round-trips a show id and ignores other channels', () => {
    const showId = '8f6d2c1e-0000-4000-8000-000000000001';
    expect(showIdFromChannel(seatEventChannel(showId))).toBe(showId);
    expect(showIdFromChannel('bmt:cache:catalog')).toBeUndefined();
  });
});

describe('stream limiter', () => {
  it('counts open streams per address and frees a place on release', () => {
    const limiter = createStreamLimiter(2);
    expect(limiter.tryAcquire('1.1.1.1')).toBe(true);
    expect(limiter.tryAcquire('1.1.1.1')).toBe(true);
    expect(limiter.tryAcquire('1.1.1.1')).toBe(false);
    expect(limiter.tryAcquire('2.2.2.2')).toBe(true);

    limiter.release('1.1.1.1');
    expect(limiter.tryAcquire('1.1.1.1')).toBe(true);
  });

  it('never goes below zero when released more than acquired', () => {
    const limiter = createStreamLimiter(1);
    limiter.release('1.1.1.1');
    expect(limiter.tryAcquire('1.1.1.1')).toBe(true);
    expect(limiter.tryAcquire('1.1.1.1')).toBe(false);
  });
});
