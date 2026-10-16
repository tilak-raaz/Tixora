import type { ReactNode } from 'react';
import { Container } from '@/components/container';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return <Container className="flex max-w-md flex-col gap-6 pt-8 sm:pt-16">{children}</Container>;
}
