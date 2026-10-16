'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';

export function InteractiveDemo() {
  const [open, setOpen] = useState(false);
  const toast = useToast();

  return (
    <div className="flex flex-wrap gap-3">
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Open sheet
      </Button>
      <Button variant="secondary" onClick={() => toast({ title: 'Seats held for 5 minutes' })}>
        Toast
      </Button>
      <Button
        variant="secondary"
        onClick={() =>
          toast({
            title: 'Seat F7 was just taken',
            description: 'Pick another seat.',
            tone: 'error',
          })
        }
      >
        Error toast
      </Button>
      <Button
        variant="secondary"
        onClick={() => toast({ title: 'Booking confirmed', tone: 'success' })}
      >
        Success toast
      </Button>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Test payment"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Fail payment
            </Button>
            <Button onClick={() => setOpen(false)}>Pay ₹550.00</Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          A sheet slides up from the bottom on phones and sits in the middle on wider screens.
        </p>
      </Sheet>
    </div>
  );
}
