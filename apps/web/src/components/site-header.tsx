'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Suspense, useState } from 'react';
import { authClient } from '@/lib/auth-client';
import { posterColour } from '@/lib/poster';
import { SITE_NAME } from '@/lib/site';
import { CityPicker } from './city-picker';
import { Container } from './container';
import { LogoMark } from './logo-mark';
import { Button, ButtonLink } from './ui/button';
import { Drawer } from './ui/drawer';
import { Skeleton } from './ui/skeleton';
import { useToast } from './ui/toast';

interface SiteHeaderProps {
  cities: { slug: string; name: string }[];
  rememberedCity: string | undefined;
}

export function SiteHeader({ cities, rememberedCity }: SiteHeaderProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-card">
      <Container className="flex h-16 items-center justify-between gap-3">
        <Link href="/" className="flex items-center gap-2.5" aria-label={`${SITE_NAME} home`}>
          <LogoMark />
          <span className="hidden font-display text-[1.6rem] leading-none tracking-wide uppercase sm:block">
            {SITE_NAME}
          </span>
        </Link>
        <div className="flex items-center gap-1.5 sm:gap-3">
          {cities.length > 0 && (
            // useSearchParams needs a Suspense boundary on statically rendered pages.
            <Suspense fallback={<Skeleton className="h-9 w-28" />}>
              <CityPicker cities={cities} remembered={rememberedCity} />
            </Suspense>
          )}
          <Account />
        </div>
      </Container>
    </header>
  );
}

function Account() {
  const { data: session, isPending } = authClient.useSession();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();

  if (isPending) return <Skeleton className="size-9 rounded-full" />;

  if (!session) {
    if (pathname === '/login' || pathname === '/signup') return null;
    return (
      <ButtonLink href={`/login?next=${encodeURIComponent(pathname)}`} variant="dark" size="sm">
        Sign in
      </ButtonLink>
    );
  }

  async function signOut() {
    setSigningOut(true);
    const { error } = await authClient.signOut();
    setSigningOut(false);
    if (error) {
      toast({ title: 'Could not sign out', description: 'Try again.', tone: 'error' });
      return;
    }
    setOpen(false);
    router.refresh();
  }

  const { name, email } = session.user;
  const display = name || email;
  // The same colour for the same person on every visit, from the poster palette.
  const colour = posterColour(email);

  return (
    <>
      <button
        type="button"
        aria-label="Account"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="flex size-9 items-center justify-center rounded-full font-display text-lg text-white ring-offset-2 transition-shadow hover:ring-2 hover:ring-ink/20"
        style={{ backgroundColor: colour }}
      >
        {display.charAt(0).toUpperCase()}
      </button>

      <Drawer open={open} onClose={() => setOpen(false)} label="Account">
        <div className="flex h-full flex-col">
          <div className="flex justify-end p-3">
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="rounded-md p-2 text-muted hover:bg-surface hover:text-ink"
            >
              <svg viewBox="0 0 20 20" className="size-5" aria-hidden>
                <path
                  d="M5 5l10 10M15 5L5 15"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          <div className="px-6">
            <span
              aria-hidden
              className="flex size-16 items-center justify-center rounded-full font-display text-3xl text-white"
              style={{ backgroundColor: colour }}
            >
              {display.charAt(0).toUpperCase()}
            </span>
            <p className="mt-4 truncate font-display text-3xl leading-tight uppercase">{display}</p>
            {name && <p className="truncate text-sm text-muted">{email}</p>}
          </div>

          <nav aria-label="Account" className="mt-6 border-t border-dashed border-line px-3 pt-3">
            <Link
              href="/bookings"
              onClick={() => setOpen(false)}
              className="group flex items-center justify-between gap-3 rounded-md px-3 py-2.5 hover:bg-surface"
            >
              <span className="flex flex-col">
                <span className="font-semibold">My bookings</span>
                <span className="text-sm text-muted">Your tickets, coming up and past</span>
              </span>
              <svg
                viewBox="0 0 20 20"
                aria-hidden
                className="size-5 text-muted group-hover:text-ink"
              >
                <path
                  d="M8 5l5 5-5 5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Link>
          </nav>

          <div className="mt-auto border-t border-line p-6">
            <Button variant="secondary" className="w-full" onClick={signOut} loading={signingOut}>
              Sign out
            </Button>
          </div>
        </div>
      </Drawer>
    </>
  );
}
