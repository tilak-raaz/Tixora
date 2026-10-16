import { describe, expect, it } from 'vitest';
import { formatCountdown, remainingMs } from '@/lib/countdown';
import {
  initialSeatMap,
  seatLabel,
  seatMapReducer,
  seatRows,
  versionSum,
  type Seat,
  type SeatMapState,
} from '@/lib/seat-state';

const seat = (
  id: string,
  x: number,
  y: number,
  version = 0,
  status: Seat['status'] = 'AVAILABLE',
): Seat => ({
  id,
  row: String.fromCharCode(65 + y),
  number: x + 1,
  x,
  y,
  category: y === 0 ? 'Prime' : 'Classic',
  pricePaise: y === 0 ? 30_000 : 20_000,
  status,
  version,
});

const start = () => initialSeatMap([seat('a', 0, 0), seat('b', 1, 0), seat('c', 0, 1)]);

describe('seat events', () => {
  it('applies a newer change and marks it for the flash', () => {
    const next = seatMapReducer(start(), {
      type: 'changes',
      seats: [{ id: 'a', status: 'UNAVAILABLE', version: 1 }],
    });
    expect(next.seats.get('a')).toMatchObject({ status: 'UNAVAILABLE', version: 1 });
    expect([...next.changed]).toEqual(['a']);
  });

  it('ignores news older than what it already has, whatever order it arrives in', () => {
    let state = seatMapReducer(start(), {
      type: 'changes',
      seats: [{ id: 'a', status: 'AVAILABLE', version: 2 }],
    });
    state = seatMapReducer(state, {
      type: 'changes',
      seats: [{ id: 'a', status: 'UNAVAILABLE', version: 1 }],
    });
    expect(state.seats.get('a')).toMatchObject({ status: 'AVAILABLE', version: 2 });
  });

  it('returns the same state when nothing changed, so React skips the render', () => {
    const state = start();
    expect(
      seatMapReducer(state, {
        type: 'changes',
        seats: [{ id: 'a', status: 'AVAILABLE', version: 0 }],
      }),
    ).toBe(state);
    expect(
      seatMapReducer(state, {
        type: 'changes',
        seats: [{ id: 'zz', status: 'UNAVAILABLE', version: 9 }],
      }),
    ).toBe(state);
  });
});

describe('snapshots', () => {
  it('keeps an event that is newer than the snapshot', () => {
    // The event for seat a (version 3) arrived before the snapshot taken at version 2.
    let state = seatMapReducer(start(), {
      type: 'changes',
      seats: [{ id: 'a', status: 'UNAVAILABLE', version: 3 }],
    });
    state = seatMapReducer(state, {
      type: 'snapshot',
      seats: [seat('a', 0, 0, 2, 'AVAILABLE'), seat('b', 1, 0, 1, 'UNAVAILABLE'), seat('c', 0, 1)],
    });
    expect(state.seats.get('a')).toMatchObject({ status: 'UNAVAILABLE', version: 3 });
    expect(state.seats.get('b')).toMatchObject({ status: 'UNAVAILABLE', version: 1 });
    expect(state.needsReload).toBe(false);
  });
});

describe('heartbeat', () => {
  it('waits one heartbeat before deciding an event was lost', () => {
    let state: SeatMapState = start(); // versions add up to 0
    state = seatMapReducer(state, { type: 'heartbeat', seatsVersion: 1 });
    expect(state.needsReload).toBe(false); // the event may be on its way

    state = seatMapReducer(state, { type: 'heartbeat', seatsVersion: 1 });
    expect(state.needsReload).toBe(true); // it was not
  });

  it('does not reload when the event arrives in between', () => {
    let state = seatMapReducer(start(), { type: 'heartbeat', seatsVersion: 1 });
    state = seatMapReducer(state, {
      type: 'changes',
      seats: [{ id: 'b', status: 'UNAVAILABLE', version: 1 }],
    });
    state = seatMapReducer(state, { type: 'heartbeat', seatsVersion: 1 });
    expect(state.needsReload).toBe(false);
    expect(versionSum(state)).toBe(1);
  });

  it('ignores heartbeats without a version, and reloads on resync', () => {
    const state = start();
    expect(seatMapReducer(state, { type: 'heartbeat', seatsVersion: undefined })).toBe(state);
    expect(seatMapReducer(state, { type: 'resync' }).needsReload).toBe(true);
  });
});

describe('layout', () => {
  it('lays seats out front row first, with gaps for aisles', () => {
    const rows = seatRows([seat('c', 0, 1), seat('b', 2, 0), seat('a', 0, 0)]);
    expect(rows.map((r) => r.label)).toEqual(['A', 'B']);
    expect(rows[0]!.cells.map((c) => c?.id ?? null)).toEqual(['a', null, 'b']);
    expect(rows[1]!.cells.map((c) => c?.id ?? null)).toEqual(['c', null, null]);
    expect(seatLabel({ row: 'F', number: 7 })).toBe('F7');
  });
});

describe('countdown', () => {
  it('rounds up and never goes below zero', () => {
    expect(formatCountdown(300_000)).toBe('5:00');
    expect(formatCountdown(299_400)).toBe('5:00');
    expect(formatCountdown(59_001)).toBe('1:00');
    expect(formatCountdown(9_000)).toBe('0:09');
    expect(formatCountdown(0)).toBe('0:00');
    expect(remainingMs('2026-10-16T10:00:00Z', Date.parse('2026-10-16T10:05:00Z'))).toBe(0);
  });
});
