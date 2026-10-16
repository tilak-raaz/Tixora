import { Container } from '@/components/container';
import { ButtonLink } from '@/components/ui/button';

export default function NotFound() {
  return (
    <Container className="flex flex-col items-start gap-4 pt-16 sm:pt-24">
      <p className="font-display text-8xl leading-none text-primary">404</p>
      <h1 className="font-display text-4xl leading-none uppercase">This page is not showing</h1>
      <p className="text-muted">The link may be old, or the show may have ended.</p>
      <ButtonLink href="/">See what is on</ButtonLink>
    </Container>
  );
}
