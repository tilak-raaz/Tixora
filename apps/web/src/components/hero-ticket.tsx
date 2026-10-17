import { cn } from '@/lib/cn';
import { Perforation } from './perforation';
import { buttonClasses } from './ui/button';

/**
 * The home page's introduction, drawn as an admit-one ticket: the red body (framed like the
 * posters) says what the site does, and the stub tears off to show what you get: two seats held
 * for you on a small seat map, printed like a real stub. The map is an illustration (aria-hidden);
 * the stub's fields say the same in words.
 */
export function HeroTicket({ cityName, listingId }: { cityName: string; listingId: string }) {
  return (
    <section
      aria-labelledby="hero-title"
      className="flex flex-col overflow-hidden rounded-card md:flex-row"
    >
      <div className="relative flex-1 bg-primary text-white">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-2.5 border border-white/25"
        />
        <div className="relative px-7 py-9 sm:px-11 sm:py-12">
          <h1
            id="hero-title"
            className="font-display text-[clamp(2.6rem,6.4vw,5rem)] leading-[0.95] uppercase"
          >
            <span className="block">Pick your seat.</span>
            <span className="block">It stays yours.</span>
          </h1>
          <p className="mt-5 max-w-[30rem] leading-relaxed text-white/85 sm:text-lg">
            Movie tickets for {cityName}&rsquo;s cinemas. The seat map changes the moment someone
            picks a seat, and the ticket comes by email.
          </p>
          <a href={`#${listingId}`} className={buttonClasses('dark', 'lg', 'mt-8')}>
            See what&rsquo;s on
          </a>
        </div>
      </div>

      {/* The tear: across on phones, down the side on wider screens. */}
      <Perforation className="bg-card md:hidden" />
      <div aria-hidden className="relative hidden w-0 md:block">
        <span className="absolute inset-y-5 -left-px border-l-2 border-dashed border-line" />
        <span className="absolute -top-2.5 -left-2.5 size-5 rounded-full bg-surface" />
        <span className="absolute -bottom-2.5 -left-2.5 size-5 rounded-full bg-surface" />
      </div>

      <div className="flex items-center gap-6 bg-card px-6 py-6 sm:gap-8 md:w-[19rem] md:flex-col md:items-stretch md:justify-center md:gap-6 md:px-7">
        <MiniSeatMap />
        <dl className="grid flex-1 grid-cols-2 content-start md:flex-none gap-x-5 gap-y-3 md:border-t md:border-dashed md:border-line md:pt-5">
          <StubField label="Row" value="D" />
          <StubField label="Seats" value="4, 5" />
          <StubField label="Screen" value="Audi 1" />
          <StubField label="Held" value="5:00" accent />
        </dl>
      </div>
    </section>
  );
}

function StubField({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={cn('font-display text-2xl leading-tight uppercase', accent && 'text-primary')}>
        {value}
      </dd>
    </div>
  );
}

/** Rows of the illustration: . free, x taken, y yours, f taken just now (flashes once). */
const ROWS = ['..xx....', '.....xx.', 'x...f...', '..xyy..x', '....xx..'];
const AISLE_AFTER = 4;

function MiniSeatMap() {
  return (
    <div aria-hidden className="flex shrink-0 flex-col items-center gap-[3px] md:gap-1">
      <div className="mb-2 h-1.5 w-[85%] rounded-[50%] border-t-[3px] border-ink/20" />
      {ROWS.map((row, y) => (
        <div key={y} className="flex gap-[3px] md:gap-1">
          {[...row].map((cell, x) => (
            <span key={x} className={cn('flex', x === AISLE_AFTER && 'ml-2')}>
              <Seat kind={cell} />
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

function Seat({ kind }: { kind: string }) {
  const shape = 'relative size-3.5 rounded-t-[4px] rounded-b-[2px] md:size-[1.15rem]';
  if (kind === 'y') return <span className={cn(shape, 'bg-primary')} />;
  if (kind === 'x' || kind === 'f') {
    return (
      <span className={cn(shape, 'bg-hatch')}>
        {kind === 'f' && (
          <span className="absolute inset-0 rounded-[inherit] motion-safe:animate-seat-taken" />
        )}
      </span>
    );
  }
  return <span className={cn(shape, 'bg-card ring-1 ring-line ring-inset')} />;
}
