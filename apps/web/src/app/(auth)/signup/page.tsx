import type { Metadata } from 'next';
import Link from 'next/link';
import { firstParam } from '@/lib/format';
import { safeNext } from '@/lib/navigation';
import { SignupForm } from './signup-form';

export const metadata: Metadata = { title: 'Create an account' };

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const next = safeNext(firstParam((await searchParams).next));

  return (
    <>
      <div>
        <h1 className="font-display text-5xl leading-none uppercase">Create an account</h1>
        <p className="mt-2 text-muted">Your bookings and tickets stay in your account.</p>
      </div>
      <SignupForm next={next} />
      <p className="text-center text-sm text-muted">
        Already have an account?{' '}
        <Link
          href={`/login?next=${encodeURIComponent(next)}`}
          className="font-semibold text-primary hover:underline"
        >
          Sign in
        </Link>
      </p>
    </>
  );
}
