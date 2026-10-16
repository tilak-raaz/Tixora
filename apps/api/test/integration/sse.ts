/** A small Server-Sent Events client for tests: Node's fetch, read as a stream. */

export interface SseEvent {
  event: string;
  data: string;
}

export interface SseConnection {
  status: number;
  headers: Headers;
  /** Every event received so far, in order. */
  events: SseEvent[];
  /** Resolves with the first event (already received or still to come) that matches. */
  waitFor(match: (event: SseEvent) => boolean, timeoutMs?: number): Promise<SseEvent>;
  close(): void;
}

export async function openSse(url: string): Promise<SseConnection> {
  const controller = new AbortController();
  const res = await fetch(url, {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  const events: SseEvent[] = [];
  const waiters = new Set<() => void>();

  if (res.ok && res.body) {
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true });
          let end: number;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            let event = 'message';
            const data: string[] = [];
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) event = line.slice(7);
              else if (line.startsWith('data: ')) data.push(line.slice(6));
            }
            if (data.length === 0) continue; // retry: and comments
            events.push({ event, data: data.join('\n') });
            for (const wake of waiters) wake();
          }
        }
      } catch {
        // Aborted by close(), or the server ended the stream.
      }
    })();
  } else {
    await res.body?.cancel();
  }

  return {
    status: res.status,
    headers: res.headers,
    events,
    waitFor(match, timeoutMs = 3_000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const found = events.find(match);
          if (!found) return false;
          waiters.delete(check);
          clearTimeout(timer);
          resolve(found);
          return true;
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(
            new Error(`no matching event within ${timeoutMs} ms; got ${JSON.stringify(events)}`),
          );
        }, timeoutMs);
        if (!check()) waiters.add(check);
      });
    },
    close() {
      controller.abort();
    },
  };
}

/** The seats in a `seats` event, keyed by id. */
export function seatsIn(event: SseEvent): Map<string, { status: string; version: number }> {
  const body = JSON.parse(event.data) as {
    seats: { id: string; status: string; version: number }[];
  };
  return new Map(body.seats.map((s) => [s.id, { status: s.status, version: s.version }]));
}
