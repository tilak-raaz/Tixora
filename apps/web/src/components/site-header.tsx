'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { authClient } from '@/lib/auth-client';
import { SITE_NAME } from '@/lib/site';
import { LogoMark } from './logo-mark';
import { Button, ButtonLink } from './ui/button';
import { Skeleton } from './ui/skeleton';
import { useToast } from './ui/toast';

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-card/90 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <LogoMark />
          <span className="font-display text-lg font-extrabold tracking-tight">{SITE_NAME}</span>
        </Link>
        <Account />
      </div>
    </header>
  );
}

function Account() {
  const { data: session, isPending } = authClient.useSession();
  const [signingOut, setSigningOut] = useState(false);
  const router = useRouter();
  const toast = useToast();

  if (isPending) return <Skeleton className="h-9 w-24 rounded-full" />;

  if (!session) {
    return (
      <ButtonLink href="/login" variant="secondary" size="sm">
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
      <span
        aria-hidden
        className="flex size-9 items-center justify-center rounded-full bg-ink font-display text-sm font-bold text-white"
      >
        {name.charAt(0).toUpperCase()}
      </span>
      <span className="hidden max-w-40 truncate text-sm font-semibold sm:block">{name}</span>
      <Button variant="ghost" size="sm" onClick={signOut} loading={signingOut}>
        Sign out
      </Button>
    </div>
  );
}
