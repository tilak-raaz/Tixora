/**
 * Dates and times for display. Show times are always shown in the city's time zone, not the
 * browser's, so a show at 7:30 PM in Rourkela reads 7:30 PM everywhere. Strings are built from
 * Intl parts so the output does not depend on the ICU version's spacing.
 */

type Parts = Partial<Record<Intl.DateTimeFormatPartTypes, string>>;

function parts(date: Date, options: Intl.DateTimeFormatOptions): Parts {
  const result: Parts = {};
  for (const part of new Intl.DateTimeFormat('en-IN', options).formatToParts(date)) {
    result[part.type] = part.value;
  }
  return result;
}

/** Today's calendar date in a time zone, as YYYY-MM-DD. */
export function todayIn(timeZone: string, now = new Date()): string {
  const p = parts(now, { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}-${p.month}-${p.day}`;
}

export function isIsoDate(value: string | undefined): value is string {
  return value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Calendar arithmetic on YYYY-MM-DD strings (no time zone involved). */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function nextDays(from: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => addDays(from, index));
}

/** Labels for a date chip: { top: 'Today' | 'Sat', day: '17', month: 'Oct' }. */
export function dateChip(date: string, today: string): { top: string; day: string; month: string } {
  const p = parts(new Date(`${date}T00:00:00Z`), {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  return {
    top: date === today ? 'Today' : (p.weekday ?? ''),
    day: p.day ?? '',
    month: p.month ?? '',
  };
}

/** The selected day as a headline: "Today", "Tomorrow" or "Sun 18 Oct". */
export function dateHeadline(date: string, today: string): string {
  if (date === today) return 'Today';
  if (date === addDays(today, 1)) return 'Tomorrow';
  const chip = dateChip(date, today);
  return `${chip.top} ${chip.day} ${chip.month}`;
}

/** A calendar date as "10 Oct 2026". */
export function formatCalendarDate(date: string): string {
  const p = parts(new Date(`${date}T00:00:00Z`), {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return `${p.day} ${p.month} ${p.year}`;
}

/** "7:30 PM" in the given time zone. */
export function formatTime(iso: string, timeZone: string): string {
  const p = parts(new Date(iso), { timeZone, hour: 'numeric', minute: '2-digit', hour12: true });
  return `${p.hour}:${p.minute} ${(p.dayPeriod ?? '').toUpperCase()}`;
}

/** "Sat, 17 Oct" in the given time zone. */
export function formatShowDate(iso: string, timeZone: string): string {
  const p = parts(new Date(iso), { timeZone, weekday: 'short', day: 'numeric', month: 'short' });
  return `${p.weekday}, ${p.day} ${p.month}`;
}

/** 135 -> "2h 15m". */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** The first value of a search param, which Next.js gives as string | string[] | undefined. */
export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
