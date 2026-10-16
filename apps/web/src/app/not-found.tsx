import { ButtonLink } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-20 text-center">
      <p className="font-display text-6xl font-extrabold text-primary">404</p>
      <h1 className="font-display text-2xl font-bold">This page is not showing</h1>
      <p className="text-muted">The link may be old, or the show may have ended.</p>
      <ButtonLink href="/">Back to home</ButtonLink>
    </div>
  );
}
