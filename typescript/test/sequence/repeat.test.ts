/**
 * The pure `repeat` core: parsing, and turning one uniform into a count.
 *
 * Hand-computed expectations throughout — a snapshot of our own output would
 * only prove we are consistent, not that we are right.
 * Spec: docs/specs/2026-07-19-repeated-values-lists-and-mix-ground-truth.md §3.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SEPARATOR,
  MAX_REPEAT,
  RepeatError,
  joinRepeatRow,
  parseRepeat,
  planRepeat,
  repeatCountFrom,
  repeatLengthPercents,
} from '../../src/sequence/repeat.js';

describe('parseRepeat', () => {
  it('is absent without the attribute', () => {
    expect(parseRepeat({})).toBeUndefined();
    expect(parseRepeat({ repeat: '   ' })).toBeUndefined();
  });

  it('reads a fixed count', () => {
    expect(parseRepeat({ repeat: '3' })).toEqual({
      min: 3,
      max: 3,
      separator: ',',
      distinct: false,
    });
  });

  it('reads a range, tolerating spaces', () => {
    expect(parseRepeat({ repeat: ' 1 .. 5 ' })).toEqual({
      min: 1,
      max: 5,
      separator: ',',
      distinct: false,
    });
  });

  it('allows 0 as a minimum (an empty list is a real value)', () => {
    expect(parseRepeat({ repeat: '0..2' })?.min).toBe(0);
  });

  it('takes the separator, including a deliberately empty one', () => {
    expect(parseRepeat({ repeat: '2', separator: ' | ' })?.separator).toBe(' | ');
    expect(parseRepeat({ repeat: '2', separator: '' })?.separator).toBe('');
    expect(parseRepeat({ repeat: '2' })?.separator).toBe(DEFAULT_SEPARATOR);
  });

  it('rejects nonsense rather than guessing', () => {
    expect(() => parseRepeat({ repeat: 'many' })).toThrow(RepeatError);
    expect(() => parseRepeat({ repeat: '1.5' })).toThrow(/whole number/);
    expect(() => parseRepeat({ repeat: '-1' })).toThrow(/negative/);
    expect(() => parseRepeat({ repeat: '5..2' })).toThrow(/maximum below its minimum/);
    expect(() => parseRepeat({ repeat: `1..${String(MAX_REPEAT + 1)}` })).toThrow(/exceed/);
  });

  it('accepts exactly the cap', () => {
    expect(parseRepeat({ repeat: `1..${String(MAX_REPEAT)}` })?.max).toBe(MAX_REPEAT);
  });
});

describe('repeatCountFrom', () => {
  const spec = { min: 1, max: 5, separator: ',' };

  it('spreads the unit interval evenly over the range', () => {
    // span = 5, so each fifth of [0,1) maps to one count.
    expect(repeatCountFrom(0, spec)).toBe(1);
    expect(repeatCountFrom(0.19, spec)).toBe(1);
    expect(repeatCountFrom(0.2, spec)).toBe(2);
    expect(repeatCountFrom(0.5, spec)).toBe(3);
    expect(repeatCountFrom(0.99, spec)).toBe(5);
  });

  it('never escapes the range, even at the boundary', () => {
    // A PRNG returning exactly 1 would otherwise land one past the top.
    expect(repeatCountFrom(1, spec)).toBe(5);
    expect(repeatCountFrom(-0.1, spec)).toBe(1);
  });

  it('a fixed count ignores the draw but still consumes it', () => {
    const fixed = { min: 3, max: 3, separator: ',' };
    for (const u of [0, 0.3, 0.7, 0.999]) expect(repeatCountFrom(u, fixed)).toBe(3);
  });

  it('a zero minimum can produce an empty row', () => {
    expect(repeatCountFrom(0, { min: 0, max: 3, separator: ',' })).toBe(0);
  });
});

describe('joinRepeatRow', () => {
  const spec = { min: 0, max: 3, separator: ',' };
  // Row-major: row 0 = a,b,c   row 1 = d,e,f
  const buffer = ['a', 'b', 'c', 'd', 'e', 'f'];

  it('takes only the kept prefix of the row', () => {
    expect(joinRepeatRow(buffer, 0, 2, spec)).toBe('a,b');
    expect(joinRepeatRow(buffer, 1, 3, spec)).toBe('d,e,f');
  });

  it('reads the right row, not a shifted one', () => {
    expect(joinRepeatRow(buffer, 1, 1, spec)).toBe('d');
  });

  it('keeping zero yields an empty string', () => {
    expect(joinRepeatRow(buffer, 0, 0, spec)).toBe('');
  });
});

/**
 * The lengths-first plan. Every assertion is hand-computed: the point is that
 * the slot space is partitioned with no gaps and no overlaps, because that is
 * exactly what lets the value quota come out exact.
 */
describe('planRepeat — lengths decided before filling', () => {
  const spec = { min: 1, max: 3, separator: ',' };

  it('totals the slots exactly', () => {
    // 2 rows of length 1, 3 of length 2, 4 of length 3 = 2 + 6 + 12 = 20
    expect(planRepeat(spec, 9, [2, 3, 4]).totalSlots).toBe(20);
  });

  it('assigns each row the length of its group', () => {
    const plan = planRepeat(spec, 9, [2, 3, 4]);
    // rows 0-1 → length 1, rows 2-4 → length 2, rows 5-8 → length 3
    expect([0, 1].map((p) => plan.lengthAt(p))).toEqual([1, 1]);
    expect([2, 3, 4].map((p) => plan.lengthAt(p))).toEqual([2, 2, 2]);
    expect([5, 6, 7, 8].map((p) => plan.lengthAt(p))).toEqual([3, 3, 3, 3]);
  });

  it('partitions the slot space with no gaps and no overlaps', () => {
    const plan = planRepeat(spec, 9, [2, 3, 4]);
    const seen = new Set<number>();
    for (let p = 0; p < 9; p++) {
      const start = plan.slotStartAt(p);
      for (let k = 0; k < plan.lengthAt(p); k++) {
        expect(seen.has(start + k), `slot ${String(start + k)} used twice`).toBe(false);
        seen.add(start + k);
      }
    }
    // Exactly the slots [0, totalSlots) — every one used, none invented.
    expect(seen.size).toBe(plan.totalSlots);
    expect(Math.min(...seen)).toBe(0);
    expect(Math.max(...seen)).toBe(plan.totalSlots - 1);
  });

  it('handles a zero-length group without stealing slots', () => {
    const withZero = { min: 0, max: 2, separator: ',' };
    const plan = planRepeat(withZero, 6, [2, 2, 2]);
    expect(plan.totalSlots).toBe(0 * 2 + 1 * 2 + 2 * 2); // 6
    expect(plan.lengthAt(0)).toBe(0);
    expect(plan.slotStartAt(0)).toBe(0);
    expect(plan.slotStartAt(1)).toBe(0); // an empty row consumes nothing
    expect(plan.slotStartAt(2)).toBe(0); // first length-1 row starts at 0
  });

  it('a fixed repeat is just one group', () => {
    const fixed = { min: 3, max: 3, separator: ',' };
    const plan = planRepeat(fixed, 4, [4]);
    expect(plan.totalSlots).toBe(12);
    expect([0, 1, 2, 3].map((p) => plan.slotStartAt(p))).toEqual([0, 3, 6, 9]);
  });

  it('splits the lengths evenly by default', () => {
    expect(repeatLengthPercents({ min: 1, max: 4, separator: ',' })).toEqual([25, 25, 25, 25]);
  });
});
