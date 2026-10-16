'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Suspense, useState } from 'react';
import { authClient } from '@/lib/auth-client';
import { SITE_NAME } from '@/lib/site';
import { CityPicker } from './city-picker';
import { Container } from './container';
import { LogoMark } from './logo-mark';
import { Button, ButtonLink } from './ui/button';
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
  const [signingOut, setSigningOut] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();

  if (isPending) return <Skeleton className="h-9 w-20" />;

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
    router.refresh();
  }

  const name = session.user.name || session.user.email;
  return (
    <div className="flex items-center gap-2">
      {/* A wrapper, because the link's own inline-flex would override `hidden`. */}
      <span className="hidden lg:block">
        <ButtonLink href="/bookings" variant="ghost" size="sm">
          My bookings
        </ButtonLink>
      </span>
      <Link
        href="/bookings"
        aria-label="My bookings"
        className="flex size-9 items-center justify-center rounded-md bg-ink font-display text-lg text-white"
      >
        {name.charAt(0).toUpperCase()}
      </Link>
      <span className="hidden max-w-36 truncate text-sm font-semibold md:block">{name}</span>
      <Button variant="ghost" size="sm" onClick={signOut} loading={signingOut}>
        Sign out
      </Button>
    </div>
  );
}
