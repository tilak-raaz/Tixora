import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tag } from '@/components/ui/tag';
import { cn } from '@/lib/cn';
import { InteractiveDemo } from './interactive-demo';

export const metadata: Metadata = { title: 'UI kit' };

const COLOURS = [
  ['primary', 'bg-primary'],
  ['primary-hover', 'bg-primary-hover'],
  ['primary-soft', 'bg-primary-soft'],
  ['ink', 'bg-ink'],
  ['muted', 'bg-muted'],
  ['line', 'bg-line'],
  ['surface', 'bg-surface'],
  ['card', 'bg-card'],
  ['info-soft', 'bg-info-soft'],
  ['success-soft', 'bg-success-soft'],
  ['warning-soft', 'bg-warning-soft'],
] as const;

const SEATS = [
  ['Available', 'border border-line bg-card'],
  ['Selected', 'bg-ink'],
  ['Held by you', 'bg-primary'],
  ['Unavailable', 'bg-hatch'],
] as const;

/** Every building block on one page, for reviewing the theme. Development only. */
export default function UiKitPage() {
  if (process.env.NODE_ENV === 'production') notFound();

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-display text-3xl font-extrabold">UI kit</h1>

      <Section title="Colours">
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
          {COLOURS.map(([name, swatch]) => (
            <div key={name} className="flex flex-col gap-1.5">
              <div className={cn('h-12 rounded-xl border border-line', swatch)} />
              <span className="text-xs text-muted">{name}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Type">
        <p className="font-display text-4xl font-extrabold">Manrope display</p>
        <p className="mt-2">Inter body text. Paise in, rupees out: ₹1,23,456.78</p>
        <p className="mt-1 text-sm text-muted">Muted secondary text</p>
      </Section>

      <Section title="Buttons">
        <div className="flex flex-wrap items-center gap-3">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="dark">Dark</Button>
          <Button variant="ghost">Ghost</Button>
          <Button loading>Paying</Button>
          <Button disabled>Disabled</Button>
          <Button size="sm">Small</Button>
          <Button size="lg">Large</Button>
        </div>
      </Section>

      <Section title="Tags">
        <div className="flex flex-wrap gap-2">
          <Tag>2D</Tag>
          <Tag tone="info">Hindi</Tag>
          <Tag tone="success">Confirmed</Tag>
          <Tag tone="warning">Held</Tag>
          <Tag tone="primary">Fast filling</Tag>
        </div>
      </Section>

      <Section title="Seats">
        <div className="flex flex-wrap gap-5">
          {SEATS.map(([label, look]) => (
            <div key={label} className="flex items-center gap-2">
              <span className={cn('size-7 rounded-lg', look)} />
              <span className="text-sm">{label}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Loading">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-32 w-full rounded-card" />
        </div>
      </Section>

      <Section title="Sheet and toast">
        <InteractiveDemo />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-card bg-card p-5 sm:p-6">
      <h2 className="mb-4 text-sm font-semibold tracking-wide text-muted uppercase">{title}</h2>
      {children}
    </section>
  );
}
