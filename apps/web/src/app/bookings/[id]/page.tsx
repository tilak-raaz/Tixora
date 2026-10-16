import type { Metadata } from 'next';
import { Container } from '@/components/container';
import { TicketView } from './ticket-view';

export const metadata: Metadata = { title: 'Your ticket' };

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Container className="flex max-w-2xl flex-col gap-6 pt-6 sm:pt-10">
      <TicketView bookingId={id} />
    </Container>
  );
}
