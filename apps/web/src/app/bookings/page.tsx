import type { Metadata } from 'next';
import { Container } from '@/components/container';
import { MyBookings } from './my-bookings';

export const metadata: Metadata = { title: 'My bookings' };

export default function MyBookingsPage() {
  return (
    <Container className="flex flex-col gap-8 pt-8 sm:pt-12">
      <h1 className="font-display text-5xl leading-none uppercase sm:text-7xl">My bookings</h1>
      <MyBookings />
    </Container>
  );
}
