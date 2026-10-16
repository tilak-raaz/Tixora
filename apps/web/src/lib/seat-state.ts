/**
 * The live seat map's state, kept apart from React so it can be tested on its own (ADR 0013).
 *
 * Two sources feed it: the seat map snapshot (GET /shows/:id/seats) and `seats` events from the
 * stream. They can arrive in any order, so every update keeps whichever version of a seat is
 * higher. Versions only grow, which also gives a cheap check for lost events: the show's seat
 * version in each heartbeat is the sum of all its seats' versions, so if our own seats still add
 * up to less than a heartbeat's figure one heartbeat later, an event never reached us.
 */

export type SeatStatus = 'AVAILABLE' | 'UNAVAILABLE';

/** A seat as the seat map endpoint returns it. */
export interface Seat {
  id: string;
  row: string;
  number: number;
  x: number;
  y: number;
  category: string;
  pricePaise: number;
  status: SeatStatus;
  version: number;
}

/** A seat in a `seats` event. */
export interface SeatChange {
  id: string;
  status: SeatStatus;
  version: number;
}

export interface SeatMapState {
  seats: Map<string, Seat>;
  /** Seats whose status an event just changed, to flash them once; cleared by the next update. */
  changed: Set<string>;
  /** A heartbeat version we were behind, waiting to see if events catch us up. */
  suspect: number | undefined;
  /** True when the map must be loaded again (a lost event, or `resync`). */
  needsReload: boolean;
}

export type SeatMapAction =
  | { type: 'snapshot'; seats: Seat[] }
  | { type: 'changes'; seats: SeatChange[] }
  | { type: 'heartbeat'; seatsVersion: number | undefined }
  | { type: 'resync' };

export function initialSeatMap(seats: Seat[] = []): SeatMapState {
  return {
    seats: new Map(seats.map((seat) => [seat.id, seat])),
    changed: new Set(),
    suspect: undefined,
    needsReload: false,
  };
}

export function versionSum(state: SeatMapState): number {
  let sum = 0;
  for (const seat of state.seats.values()) sum += seat.version;
  return sum;
}

export function seatMapReducer(state: SeatMapState, action: SeatMapAction): SeatMapState {
  switch (action.type) {
    case 'snapshot': {
      const seats = new Map(state.seats);
      for (const seat of action.seats) {
        const known = seats.get(seat.id);
        // An event newer than the snapshot may already be here; keep it.
        if (!known || seat.version >= known.version) seats.set(seat.id, seat);
      }
      return { seats, changed: new Set(), suspect: undefined, needsReload: false };
    }

    case 'changes': {
      let seats: Map<string, Seat> | undefined;
      const changed = new Set<string>();
      for (const change of action.seats) {
        const known = (seats ?? state.seats).get(change.id);
        // Unknown seats come with the next snapshot; older news is ignored.
        if (!known || change.version <= known.version) continue;
        seats ??= new Map(state.seats);
        seats.set(change.id, { ...known, status: change.status, version: change.version });
        if (known.status !== change.status) changed.add(change.id);
      }
      if (!seats) return state;
      return { ...state, seats, changed };
    }

    case 'heartbeat': {
      if (action.seatsVersion === undefined) return state; // a keep-alive without a version
      const local = versionSum(state);
      // Still behind a figure from the previous heartbeat: those events are not coming.
      if (state.suspect !== undefined && local < state.suspect) {
        return { ...state, suspect: undefined, needsReload: true };
      }
      // Behind now could just mean an event is on its way; look again next time.
      return { ...state, suspect: action.seatsVersion > local ? action.seatsVersion : undefined };
    }

    case 'resync':
      return { ...state, needsReload: true };
  }
}

/** "F7" */
export function seatLabel(seat: Pick<Seat, 'row' | 'number'>): string {
  return `${seat.row}${seat.number}`;
}

export interface SeatRow {
  y: number;
  label: string;
  category: string;
  /** One cell per grid column; null is an aisle or a gap. */
  cells: (Seat | null)[];
}

/** Lays the seats out row by row, front row first, with gaps where the grid has no seat. */
export function seatRows(seats: Iterable<Seat>): SeatRow[] {
  const all = [...seats];
  if (all.length === 0) return [];
  const width = Math.max(...all.map((s) => s.x)) + 1;
  const byRow = new Map<number, Seat[]>();
  for (const seat of all) {
    const row = byRow.get(seat.y) ?? [];
    row.push(seat);
    byRow.set(seat.y, row);
  }
  return [...byRow.entries()]
    .sort(([a], [b]) => a - b)
    .map(([y, rowSeats]) => {
      const cells: (Seat | null)[] = Array.from({ length: width }, () => null);
      for (const seat of rowSeats) cells[seat.x] = seat;
      return { y, label: rowSeats[0]!.row, category: rowSeats[0]!.category, cells };
    });
}
