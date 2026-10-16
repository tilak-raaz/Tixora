import { describe, expect, it } from 'vitest';
import { authErrorMessage } from '@/lib/auth-errors';
import type { City } from '@/lib/catalog';
import { pickCity } from '@/lib/city';
import { clientIp } from '@/lib/forwarded';
import { safeNext } from '@/lib/navigation';
import { POSTER_COLOURS, posterColour } from '@/lib/poster';

const city = (slug: string): City => ({
  id: slug,
  name: slug,
  slug,
  state: 'Odisha',
  timezone: 'Asia/Kolkata',
});

describe('pickCity', () => {
  const cities = [city('bhubaneswar'), city('rourkela')];

  it('prefers the URL, then the cookie, then the first city', () => {
    expect(pickCity(cities, 'rourkela', 'bhubaneswar')?.slug).toBe('rourkela');
    expect(pickCity(cities, undefined, 'rourkela')?.slug).toBe('rourkela');
    expect(pickCity(cities, 'atlantis', 'nowhere')?.slug).toBe('bhubaneswar');
    expect(pickCity([], 'rourkela', undefined)).toBeUndefined();
  });
});

describe('clientIp', () => {
  it('trusts only the last X-Forwarded-For entry, the one our proxy added', () => {
    expect(clientIp('1.1.1.1, 203.0.113.9')).toBe('203.0.113.9');
    expect(clientIp('203.0.113.9')).toBe('203.0.113.9');
    expect(clientIp(null)).toBeUndefined();
    expect(clientIp('')).toBeUndefined();
  });
});

describe('safeNext', () => {
  it('allows only paths on this site', () => {
    expect(safeNext('/shows/abc')).toBe('/shows/abc');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext(undefined)).toBe('/');
  });
});

describe('authErrorMessage', () => {
  it('explains the common failures', () => {
    expect(authErrorMessage({ status: 429 })).toMatch(/too many attempts/i);
    expect(authErrorMessage({ status: 401, code: 'INVALID_EMAIL_OR_PASSWORD' })).toBe(
      'Wrong email or password.',
    );
    expect(authErrorMessage({ status: 422, code: 'USER_ALREADY_EXISTS' })).toMatch(
      /already exists/,
    );
    expect(authErrorMessage({ status: 400, message: 'Odd failure' })).toBe('Odd failure');
    expect(authErrorMessage({})).toBe('Something went wrong. Try again.');
  });
});

describe('posterColour', () => {
  it('gives a title the same palette colour every time', () => {
    expect(posterColour('Monsoon Express')).toBe(posterColour('Monsoon Express'));
    expect(POSTER_COLOURS).toContain(posterColour('Monsoon Express'));
  });
});
