'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { CITY_COOKIE_NAME } from '@/lib/city';

interface CityPickerProps {
  cities: { slug: string; name: string }[];
  /** The city remembered in the cookie; the URL's ?city= wins when present. */
  remembered: string | undefined;
}

/** The city in the header. Changing it remembers the choice and reloads the page from today. */
export function CityPicker({ cities, remembered }: CityPickerProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const fromUrl = searchParams.get('city');
  const selected =
    cities.find((city) => city.slug === fromUrl)?.slug ??
    cities.find((city) => city.slug === remembered)?.slug ??
    cities[0]?.slug;

  if (!selected) return null;

  function choose(slug: string) {
    document.cookie = `${CITY_COOKIE_NAME}=${encodeURIComponent(slug)}; path=/; max-age=31536000; samesite=lax`;
    // Pages that list shows by city start again in the new city; others only need the cookie.
    if (pathname === '/' || pathname.startsWith('/movies/')) {
      router.push(`${pathname}?city=${encodeURIComponent(slug)}`);
    } else {
      router.refresh();
    }
  }

  return (
    <label className="relative inline-flex items-center text-ink">
      <span className="sr-only">City</span>
      <svg
        viewBox="0 0 20 20"
        aria-hidden
        className="pointer-events-none absolute left-2.5 size-4 text-primary"
      >
        <path
          fill="currentColor"
          d="M10 2a6 6 0 0 0-6 6c0 4.2 5.1 9.4 5.4 9.6a.8.8 0 0 0 1.2 0C10.9 17.4 16 12.2 16 8a6 6 0 0 0-6-6Zm0 8.3A2.3 2.3 0 1 1 10 5.7a2.3 2.3 0 0 1 0 4.6Z"
        />
      </svg>
      <select
        value={selected}
        onChange={(event) => choose(event.target.value)}
        className="h-9 max-w-36 cursor-pointer appearance-none truncate rounded-md bg-transparent pr-8 pl-8 text-sm font-semibold hover:bg-surface"
      >
        {cities.map((city) => (
          <option key={city.slug} value={city.slug}>
            {city.name}
          </option>
        ))}
      </select>
      <svg
        viewBox="0 0 20 20"
        aria-hidden
        className="pointer-events-none absolute right-2.5 size-4 text-muted"
      >
        <path
          d="M5 8l5 5 5-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    </label>
  );
}
