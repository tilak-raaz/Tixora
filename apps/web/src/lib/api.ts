import { ERROR_CODES, type ErrorBody, type ErrorCode } from '@bmt/shared';

/** Where server components reach the API. The browser always uses its own origin. */
const SERVER_API_URL = process.env.API_URL ?? 'http://localhost:4000';

/** Every failed API call throws this. Branch on `code`, never on `message`. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;
  readonly code: ErrorCode;
  readonly requestId: string | undefined;
  readonly details: unknown;
  /** From Retry-After on 429 and 503 responses. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    extra: { requestId?: string; details?: unknown; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = extra.requestId;
    this.details = extra.details;
    this.retryAfterSeconds = extra.retryAfterSeconds;
  }
}

export function isApiError(err: unknown, ...codes: ErrorCode[]): err is ApiError {
  return err instanceof ApiError && (codes.length === 0 || codes.includes(err.code));
}

/** `/cities` -> `/api/v1/cities` in the browser, `http://api:4000/api/v1/cities` on the server. */
export function apiUrl(path: string): string {
  const base = typeof window === 'undefined' ? SERVER_API_URL : '';
  return `${base}/api/v1${path}`;
}

export interface ApiRequest extends Omit<RequestInit, 'body'> {
  /** Sent as JSON with Content-Type: application/json. */
  json?: unknown;
}

/** Calls the API and returns the parsed JSON body, or throws an ApiError. */
export async function api<T>(path: string, request: ApiRequest = {}): Promise<T> {
  const { json, headers: initHeaders, ...init } = request;
  const headers = new Headers(initHeaders);
  headers.set('Accept', 'application/json');
  if (json !== undefined) headers.set('Content-Type', 'application/json');

  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      credentials: 'same-origin',
      ...init,
      headers,
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
  } catch {
    throw new ApiError(
      0,
      'SERVICE_UNAVAILABLE',
      'Could not reach the server. Check your connection and try again.',
    );
  }

  if (res.status === 204) return undefined as T;
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) throw toApiError(res.status, res.headers, body);
  return body as T;
}

/** Turns an error response into an ApiError, whether or not it has our error body. */
export function toApiError(status: number, headers: Headers, body: unknown): ApiError {
  const retryAfterSeconds = parseRetryAfter(headers.get('Retry-After'));
  if (isErrorBody(body)) {
    const { code, message, requestId, details } = body.error;
    const known = (ERROR_CODES as readonly string[]).includes(code);
    return new ApiError(status, known ? code : codeForStatus(status), message, {
      ...(requestId === undefined ? {} : { requestId }),
      details,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
  }
  return new ApiError(status, codeForStatus(status), messageForStatus(status), {
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });
}

function isErrorBody(body: unknown): body is ErrorBody {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  const error = (body as { error: unknown }).error;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

/** Retry-After is either a number of seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'VALIDATION_FAILED';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 429:
      return 'RATE_LIMITED';
    case 502:
    case 503:
    case 504:
      return 'SERVICE_UNAVAILABLE';
    default:
      return 'INTERNAL';
  }
}

function messageForStatus(status: number): string {
  if (status === 429) return 'Too many requests. Wait a moment and try again.';
  if (status >= 502 && status <= 504) return 'The server is unavailable. Try again shortly.';
  if (status === 404) return 'Not found.';
  return 'Something went wrong. Try again.';
}
