'use client';

import { useCallback, useEffect, useReducer, useState } from 'react';
import { api } from '@/lib/api';
import { initialSeatMap, seatMapReducer, type Seat, type SeatChange } from '@/lib/seat-state';

/** connecting: opening the stream. live: events flowing. reconnecting: the browser retries by itself. offline: given up. */
export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

/**
 * The show's seat map, kept current by the seat event stream (ADR 0013). Starts from the
 * server-rendered snapshot, loads the map again whenever the stream (re)connects or reports a
 * gap, and merges every event by version.
 */
export function useLiveSeats(showId: string, initialSeats: Seat[]) {
  const [state, dispatch] = useReducer(seatMapReducer, initialSeats, initialSeatMap);
  const [status, setStatus] = useState<LiveStatus>('connecting');

  const reload = useCallback(async () => {
    try {
      const { seats } = await api<{ seats: Seat[] }>(`/shows/${encodeURIComponent(showId)}/seats`);
      dispatch({ type: 'snapshot', seats });
    } catch {
      // The next heartbeat or reconnect tries again; the map stays as it was.
    }
  }, [showId]);

  useEffect(() => {
    const source = new EventSource(`/api/v1/shows/${encodeURIComponent(showId)}/seats/events`);

    // `ready` comes on every connect, so a reconnect always starts from a fresh map.
    source.addEventListener('ready', () => {
      setStatus('live');
      void reload();
    });
    source.addEventListener('seats', (event) => {
      const { seats } = JSON.parse((event as MessageEvent<string>).data) as { seats: SeatChange[] };
      dispatch({ type: 'changes', seats });
    });
    source.addEventListener('heartbeat', (event) => {
      const { seatsVersion } = JSON.parse((event as MessageEvent<string>).data) as {
        seatsVersion?: number;
      };
      dispatch({ type: 'heartbeat', seatsVersion });
    });
    source.addEventListener('resync', () => dispatch({ type: 'resync' }));
    source.onerror = () => {
      // CLOSED means the server refused (429, 503): the browser will not retry by itself.
      setStatus(source.readyState === EventSource.CLOSED ? 'offline' : 'reconnecting');
    };

    return () => source.close();
  }, [showId, reload]);

  useEffect(() => {
    if (state.needsReload) void reload();
  }, [state.needsReload, reload]);

  return { seats: state.seats, changed: state.changed, status, reload };
}
