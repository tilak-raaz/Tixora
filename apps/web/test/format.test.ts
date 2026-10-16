import { describe, expect, it } from 'vitest';
import {
  addDays,
  dateChip,
  dateHeadline,
  firstParam,
  formatCalendarDate,
  formatDuration,
  formatShowDate,
  formatTime,
  isIsoDate,
  nextDays,
  todayIn,
} from '@/lib/format';

describe('dates', () => {
  it("finds today's date in the city's time zone, not UTC", () => {
    // 20:00 UTC on the 16th is already 01:30 on the 17th in India.
    const now = new Date('2026-10-16T20:00:00Z');
    expect(todayIn('Asia/Kolkata', now)).toBe('2026-10-17');
    expect(todayIn('UTC', now)).toBe('2026-10-16');
  });

  it('adds days across month and year ends', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(nextDays('2026-10-30', 3)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01']);
  });

  it('accepts only YYYY-MM-DD', () => {
    expect(isIsoDate('2026-10-17')).toBe(true);
    expect(isIsoDate('17-10-2026')).toBe(false);
    expect(isIsoDate(undefined)).toBe(false);
  });

  it('labels date chips, calling today "Today"', () => {
    expect(dateChip('2026-10-17', '2026-10-17')).toEqual({ top: 'Today', day: '17', month: 'Oct' });
    expect(dateChip('2026-10-18', '2026-10-17')).toEqual({ top: 'Sun', day: '18', month: 'Oct' });
  });
});

describe('headlines', () => {
  it('names today and tomorrow, and dates further out', () => {
    expect(dateHeadline('2026-10-17', '2026-10-17')).toBe('Today');
    expect(dateHeadline('2026-10-18', '2026-10-17')).toBe('Tomorrow');
    expect(dateHeadline('2026-10-20', '2026-10-17')).toBe('Tue 20 Oct');
    expect(formatCalendarDate('2026-10-10')).toBe('10 Oct 2026');
  });
});

describe('show times', () => {
  it("formats in the city's time zone", () => {
    // 14:00 UTC is 7:30 PM in India.
    expect(formatTime('2026-10-17T14:00:00Z', 'Asia/Kolkata')).toBe('7:30 PM');
    expect(formatTime('2026-10-17T04:15:00Z', 'Asia/Kolkata')).toBe('9:45 AM');
    expect(formatShowDate('2026-10-17T14:00:00Z', 'Asia/Kolkata')).toBe('Sat, 17 Oct');
  });

  it('formats durations', () => {
    expect(formatDuration(135)).toBe('2h 15m');
    expect(formatDuration(120)).toBe('2h');
    expect(formatDuration(45)).toBe('45m');
  });
});

describe('firstParam', () => {
  it('takes the first value of a repeated search param', () => {
    expect(firstParam(['a', 'b'])).toBe('a');
    expect(firstParam('a')).toBe('a');
    expect(firstParam(undefined)).toBeUndefined();
  });
});
