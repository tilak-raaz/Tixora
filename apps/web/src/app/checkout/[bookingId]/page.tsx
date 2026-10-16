import type { Metadata } from 'next';
import { Container } from '@/components/container';
import { CheckoutView } from './checkout-view';

export const metadata: Metadata = { title: 'Your seats' };

export default async function CheckoutPage({ params }: { params: Promise<{ bookingId: string }> }) {
  const { bookingId } = await params;
  return (
    <Container className="flex max-w-2xl flex-col gap-6 pt-6 sm:pt-10">
      <CheckoutView bookingId={bookingId} />
    </Container>
  );
}
