import { formatPaise } from '@bmt/shared';
import { describe, expect, it } from 'vitest';
import { createScreenSchema } from '../../src/modules/catalog/schemas';
import { layoutToSeats } from '../../src/modules/catalog/service';

const CAT = '00000000-0000-4000-8000-000000000001';

describe('layoutToSeats', () => {
  it('numbers seats from 1 and places each row on its own grid line', () => {
    const seats = layoutToSeats([
      { label: 'A', categoryId: CAT, seats: 3, aisleAfter: [] },
      { label: 'B', categoryId: CAT, seats: 2, aisleAfter: [] },
    ]);
    expect(seats.map((s) => [s.rowLabel, s.seatNumber, s.gridX, s.gridY])).toEqual([
      ['A', 1, 0, 0],
      ['A', 2, 1, 0],
      ['A', 3, 2, 0],
      ['B', 1, 0, 1],
      ['B', 2, 1, 1],
    ]);
  });

  it('leaves an empty grid cell after each aisle', () => {
    const seats = layoutToSeats([{ label: 'A', categoryId: CAT, seats: 6, aisleAfter: [2, 4] }]);
    expect(seats.map((s) => s.gridX)).toEqual([0, 1, 3, 4, 6, 7]);
  });
});

describe('createScreenSchema', () => {
  it('rejects repeated row labels', () => {
    const result = createScreenSchema.safeParse({
      theatreId: CAT,
      name: 'Audi 1',
      rows: [
        { label: 'A', categoryId: CAT, seats: 4 },
        { label: 'A', categoryId: CAT, seats: 4 },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe('formatPaise', () => {
  it('formats paise as rupees with Indian digit grouping', () => {
    expect(formatPaise(55_000)).toBe('₹550.00');
    expect(formatPaise(12_345_678)).toBe('₹1,23,456.78');
  });
});
