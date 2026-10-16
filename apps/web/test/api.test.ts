import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, apiUrl, isApiError, parseRetryAfter, toApiError } from '@/lib/api';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('toApiError', () => {
  it('keeps the code, message and request id from our error body', () => {
    const err = toApiError(409, new Headers(), {
      error: { code: 'SEATS_UNAVAILABLE', message: 'Seat F7 is taken', requestId: 'req-1' },
    });
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 409,
      code: 'SEATS_UNAVAILABLE',
      message: 'Seat F7 is taken',
      requestId: 'req-1',
    });
  });

  it('reads Retry-After on 429', () => {
    const err = toApiError(429, new Headers({ 'Retry-After': '12' }), {
      error: { code: 'RATE_LIMITED', message: 'Too many requests' },
    });
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAfterSeconds).toBe(12);
  });

  it('falls back to a code from the status when the body is not ours', () => {
    expect(toApiError(502, new Headers(), undefined).code).toBe('SERVICE_UNAVAILABLE');
    expect(toApiError(500, new Headers(), '<html>').code).toBe('INTERNAL');
    expect(toApiError(404, new Headers(), { message: 'nope' }).code).toBe('NOT_FOUND');
  });

  it('maps a code it does not know to one from the status, keeping the message', () => {
    const err = toApiError(409, new Headers(), {
      error: { code: 'SOMETHING_NEW', message: 'A newer API said no' },
    });
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toBe('A newer API said no');
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    const now = Date.parse('2026-10-16T10:00:00Z');
    expect(parseRetryAfter('30', now)).toBe(30);
    expect(parseRetryAfter('Fri, 16 Oct 2026 10:00:05 GMT', now)).toBe(5);
    expect(parseRetryAfter('Fri, 16 Oct 2026 09:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter('soon', now)).toBeUndefined();
  });
});

describe('api', () => {
  it('calls the API directly when running on the server', () => {
    expect(apiUrl('/cities')).toBe('http://localhost:4000/api/v1/cities');
  });

  it('sends JSON and returns the parsed body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, { booking: { id: 'b1' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await api<{ booking: { id: string } }>('/bookings', {
      method: 'POST',
      json: { showId: 's1', seatIds: ['a'] },
    });

    expect(result.booking.id).toBe('b1');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:4000/api/v1/bookings');
    expect(init.body).toBe('{"showId":"s1","seatIds":["a"]}');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
  });

  it('returns undefined for 204', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    await expect(api('/bookings/b1/hold', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('throws ApiError on an error response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(409, { error: { code: 'SEATS_UNAVAILABLE', message: 'Taken' } }),
      ),
    );
    const err = await api('/bookings', { method: 'POST', json: {} }).catch((e: unknown) => e);
    expect(isApiError(err, 'SEATS_UNAVAILABLE')).toBe(true);
    expect(isApiError(err, 'RATE_LIMITED')).toBe(false);
  });

  it('turns a network failure into SERVICE_UNAVAILABLE with status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const err = await api('/cities').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, code: 'SERVICE_UNAVAILABLE' });
  });
});
