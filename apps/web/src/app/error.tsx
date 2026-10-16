'use client';

import { Container } from '@/components/container';
import { Button } from '@/components/ui/button';

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <Container className="flex flex-col items-start gap-4 pt-16 sm:pt-24">
      <h1 className="font-display text-4xl leading-none uppercase">This page did not load</h1>
      <p className="text-muted">
        The server did not answer. This is usually brief, so try again in a moment.
      </p>
      <Button onClick={reset}>Try again</Button>
    </Container>
  );
}
