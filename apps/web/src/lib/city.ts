import type { City } from './catalog';

/** The cookie that remembers the visitor's city. Free of server imports so the picker can use it. */
export const CITY_COOKIE_NAME = 'bmt_city';

/** Picks the city from the URL, then the remembered cookie, then the first city. */
export function pickCity(
  cities: City[],
  fromUrl: string | undefined,
  fromCookie: string | undefined,
): City | undefined {
  return (
    cities.find((city) => city.slug === fromUrl) ??
    cities.find((city) => city.slug === fromCookie) ??
    cities[0]
  );
}
