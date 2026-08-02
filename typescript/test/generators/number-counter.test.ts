import { describe, expect, it } from 'vitest';

import { decrementGenerator, incrementGenerator } from '../../src/generators/counter.js';
import {
  numberGenerator,
  parseNumberLengthChoices,
  parseNumberRanges,
} from '../../src/generators/number.js';
import { createPrng } from '../../src/prng/prng.js';

describe('numberGenerator', () => {
  it('defaults to one random digit when no range or length is given', () => {
    const out = numberGenerator({})(100, createPrng('default-digit'));
    expect(out.some((v) => v === '0')).toBe(true);
    for (const v of out) {
      expect(v).toMatch(/^\d$/);
    }
  });

  it('supports bit shorthand', () => {
    const out = numberGenerator({ range: 'bit' })(100, createPrng('bit'));
    expect(new Set(out)).toEqual(new Set(['0', '1']));
  });

  it('produces integers in [min, max] inclusive', () => {
    const gen = numberGenerator({ range: '10..20' });
    const out = gen(200, createPrng('n'));
    for (const v of out) {
      const n = Number(v);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(10);
      expect(n).toBeLessThanOrEqual(20);
    }
  });

  it('is deterministic for the same seed', () => {
    const a = numberGenerator({ range: '0..1000' })(50, createPrng('s'));
    const b = numberGenerator({ range: '0..1000' })(50, createPrng('s'));
    expect(a).toEqual(b);
  });

  it('supports negative lower bounds', () => {
    const out = numberGenerator({ range: '-5..5' })(200, createPrng('negative'));
    for (const v of out) {
      const n = Number(v);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(-5);
      expect(n).toBeLessThanOrEqual(5);
    }
  });

  it('supports dot-dot ranges for unambiguous negative bounds', () => {
    const out = numberGenerator({ range: '-500..-200' })(200, createPrng('negative-dotdot'));
    for (const v of out) {
      const n = Number(v);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(-500);
      expect(n).toBeLessThanOrEqual(-200);
    }
  });

  it('supports comma-separated range lists', () => {
    const out = numberGenerator({ range: '[0..100],[345..678],[1934..2026]' })(
      500,
      createPrng('multi-range'),
    );
    const seenBuckets = new Set<string>();
    for (const v of out) {
      const n = Number(v);
      const inFirst = n >= 0 && n <= 100;
      const inSecond = n >= 345 && n <= 678;
      const inThird = n >= 1934 && n <= 2026;
      expect(inFirst || inSecond || inThird).toBe(true);
      if (inFirst) seenBuckets.add('first');
      if (inSecond) seenBuckets.add('second');
      if (inThird) seenBuckets.add('third');
    }
    expect(seenBuckets).toEqual(new Set(['first', 'second', 'third']));
  });

  it('parses ranges with spaces and negative bounds', () => {
    expect(parseNumberRanges(' [ -10..-1 ], [ 5..9 ] ')).toEqual([
      { min: -10, max: -1 },
      { min: 5, max: 9 },
    ]);
  });

  it('pads with leading zeros when length is given', () => {
    const gen = numberGenerator({ range: '1..9', length: 4 });
    const out = gen(30, createPrng('pad'));
    for (const v of out) {
      expect(v).toHaveLength(4);
      expect(v).toMatch(/^0+\d$/);
    }
  });

  it('preserves width encoded by leading zeros in range bounds', () => {
    const out = numberGenerator({ range: '0000..9999' })(200, createPrng('encoded-width'));
    expect(out.some((v) => v.startsWith('0'))).toBe(true);
    for (const v of out) {
      expect(v).toHaveLength(4);
      expect(v).toMatch(/^\d{4}$/);
    }
  });

  it('avoids leading zero when first_zero=false is requested', () => {
    // Range 1..99, padded to 3 digits ("001".."099") — every draw has
    // at least one leading zero unless first_zero protection kicks in.
    // With first_zero=false, the generator redraws until the first digit
    // is non-zero. Range 1..99 includes numbers 1..9 (padded to 001..009)
    // and 10..99 (padded to 010..099) — so only 90 of 99 possible values
    // satisfy the non-leading-zero rule.
    const gen = numberGenerator({ range: '1..999', length: 3, firstZero: false });
    const out = gen(100, createPrng('fz'));
    for (const v of out) {
      expect(v[0]).not.toBe('0');
    }
  });

  it('generates fixed-length digit strings when range is omitted', () => {
    const gen = numberGenerator({ length: 10 });
    const out = gen(200, createPrng('digit-string'));
    for (const v of out) {
      expect(v).toHaveLength(10);
      expect(v).toMatch(/^[1-9]\d{9}$/);
    }
  });

  it('allows leading zeros in digit strings when firstZero=true', () => {
    const out = numberGenerator({ length: 10, firstZero: true })(
      200,
      createPrng('digit-string-leading-zero'),
    );
    expect(out.some((v) => v.startsWith('0'))).toBe(true);
    for (const v of out) {
      expect(v).toHaveLength(10);
      expect(v).toMatch(/^\d{10}$/);
    }
  });

  it('supports random length ranges', () => {
    const out = numberGenerator({ length: '2-10' })(200, createPrng('length-range'));
    const lengths = new Set(out.map((v) => v.length));
    expect(Math.min(...lengths)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(10);
    expect(lengths.size).toBeGreaterThan(1);
  });

  it('supports percent distributions across length groups', () => {
    const out = numberGenerator({ length: '2,10-12', percent: '85,15' })(
      100,
      createPrng('length-percent'),
    );
    expect(out.filter((v) => v.length === 2)).toHaveLength(85);
    expect(out.filter((v) => v.length >= 10 && v.length <= 12)).toHaveLength(15);
  });

  it('can generate digit strings larger than safe integer sizes', () => {
    const [value] = numberGenerator({ length: 1000, firstZero: false })(
      1,
      createPrng('huge-digit-string'),
    );
    expect(value).toHaveLength(1000);
    expect(value).toMatch(/^[1-9]\d{999}$/);
  });

  it('throws on malformed range', () => {
    expect(() => numberGenerator({ range: 'not-a-range' })).toThrow(/invalid/);
    expect(() => numberGenerator({ range: '10-20' })).toThrow(/invalid/);
    expect(() => numberGenerator({ range: '20-10' })).toThrow(/invalid/);
    expect(() => numberGenerator({ range: '5' })).toThrow(/invalid/);
    expect(() => numberGenerator({ range: '[0..100],bad' })).toThrow(/invalid/);
    expect(() => numberGenerator({ length: 0 })).toThrow(/invalid length/);
    expect(() => numberGenerator({ length: '10-2' })).toThrow(/invalid length/);
  });

  it('parses length groups', () => {
    expect(parseNumberLengthChoices('2,10-12')).toEqual([
      { min: 2, max: 2 },
      { min: 10, max: 12 },
    ]);
  });
});

describe('incrementGenerator', () => {
  it('starts at `start` and advances by `step` per cell', () => {
    const gen = incrementGenerator({ start: 100, step: 5 });
    const out = gen(6, createPrng('unused'));
    expect(out).toEqual(['100', '105', '110', '115', '120', '125']);
  });

  it('defaults start=0 step=1', () => {
    const gen = incrementGenerator();
    const out = gen(4, createPrng('unused'));
    expect(out).toEqual(['0', '1', '2', '3']);
  });

  it('is deterministic regardless of prng', () => {
    const a = incrementGenerator({ start: 10 })(5, createPrng('a'));
    const b = incrementGenerator({ start: 10 })(5, createPrng('b'));
    expect(a).toEqual(b);
  });
});

describe('decrementGenerator', () => {
  it('starts at `start` and subtracts `step` per cell', () => {
    const gen = decrementGenerator({ start: 10, step: 2 });
    const out = gen(4, createPrng('unused'));
    expect(out).toEqual(['10', '8', '6', '4']);
  });

  it('allows negative values', () => {
    const gen = decrementGenerator({ start: 1, step: 1 });
    const out = gen(4, createPrng('unused'));
    expect(out).toEqual(['1', '0', '-1', '-2']);
  });
});
