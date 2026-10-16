import type { Metadata } from 'next';
import Link from 'next/link';
import { firstParam } from '@/lib/format';
import { safeNext } from '@/lib/navigation';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const next = safeNext(firstParam((await searchParams).next));

  return (
    <>
      <div>
        <h1 className="font-display text-5xl leading-none uppercase">Sign in</h1>
        <p className="mt-2 text-muted">To hold seats, pay and keep your tickets.</p>
      </div>
      <LoginForm next={next} />
      <p className="text-center text-sm text-muted">
        New here?{' '}
        <Link
          href={`/signup?next=${encodeURIComponent(next)}`}
          className="font-semibold text-primary hover:underline"
        >
          Create an account
        </Link>
      </p>
    </>
  );
}
