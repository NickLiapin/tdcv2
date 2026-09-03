import { describe, expect, it } from 'vitest';

import {
  computeAllowedIntervals,
  numberGenerator,
  parseNumberIntervalList,
  parseNumberRanges,
} from '../../src/generators/number.js';
import { createPrng } from '../../src/prng/prng.js';

describe('number include/exclude — parsing', () => {
  it('parses single ints, ranges, and comma lists', () => {
    expect(parseNumberIntervalList('3', 'exclude')).toEqual([{ min: 3, max: 3 }]);
    expect(parseNumberIntervalList('40..60', 'exclude')).toEqual([{ min: 40, max: 60 }]);
    expect(parseNumberIntervalList('3,7,90..99', 'exclude')).toEqual([
      { min: 3, max: 3 },
      { min: 7, max: 7 },
      { min: 90, max: 99 },
    ]);
  });

  it('throws on a reversed range', () => {
    expect(() => parseNumberIntervalList('60..40', 'exclude')).toThrow(/reversed/);
  });
});

describe('number range list — an unclosed bracket does not hang', () => {
  /**
   * The list used to be read with `^\[\s*([^\]]+?)\s*\]`, where `\s*` and
   * `[^\]]+?` can both match a space — so on `[` followed by a long run of
   * spaces and no `]`, the engine tried every way to split the run between
   * them. Ten thousand spaces did not finish in five minutes: a config that
   * stops the generator rather than being rejected by it.
   *
   * A time bound is a blunt assertion, but it is the only one that states the
   * actual property. The margin is wide enough that a slow CI machine is not
   * the thing being measured — the old code needed minutes, not milliseconds.
   */
  it('rejects a million spaces in well under a second', () => {
    const started = Date.now();
    expect(() => parseNumberRanges(`[${' '.repeat(1_000_000)}`)).toThrow(/invalid range list/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('still parses and rejects exactly what it did before', () => {
    expect(parseNumberRanges('[1..9]')).toEqual([{ min: 1, max: 9 }]);
    expect(parseNumberRanges('  [ 1..9 ] ,[20..30]  ')).toEqual([
      { min: 1, max: 9 },
      { min: 20, max: 30 },
    ]);
    expect(() => parseNumberRanges('[1..9')).toThrow(/invalid range list/);
    expect(() => parseNumberRanges('[1..9] [2..3]')).toThrow(/invalid range list/);
    expect(() => parseNumberRanges('[1..9],')).toThrow(/invalid range list/);
    expect(() => parseNumberRanges('[]')).toThrow(/invalid range/);
  });

  /*
   * `number` was a generator of RANGES, and that is why arithmetic ended up on
   * the text generator: there was no way to say "always 50" or "one of 10, 20,
   * 35", so those had to be written as `<gen type="text">` — a list of strings
   * that happen to look numeric. `anomaly=` then had to work there, and on a
   * list of strings the only possible check is "does this parse as a number",
   * which `hello,50,error,20` passes while silently delivering half the
   * requested rate.
   */
  it('takes a single number — the form that used to send people to text', () => {
    expect(parseNumberRanges('45')).toEqual([{ min: 45, max: 45 }]);
    expect(parseNumberRanges('-7')).toEqual([{ min: -7, max: -7 }]);
    expect(parseNumberRanges('0')).toEqual([{ min: 0, max: 0 }]);
  });

  it('takes a list of numbers, which is a list of one-point ranges', () => {
    expect(parseNumberRanges('10,20,35')).toEqual([
      { min: 10, max: 10 },
      { min: 20, max: 20 },
      { min: 35, max: 35 },
    ]);
  });

  it('mixes numbers and ranges, with brackets optional throughout', () => {
    expect(parseNumberRanges('0,10..20,99')).toEqual([
      { min: 0, max: 0 },
      { min: 10, max: 20 },
      { min: 99, max: 99 },
    ]);
    expect(parseNumberRanges('[5],[10..20]')).toEqual([
      { min: 5, max: 5 },
      { min: 10, max: 20 },
    ]);
  });

  it('keeps the zero-padding rule a single value inherits', () => {
    // Leading zeros set the width, exactly as they do for a range: `050` is
    // three characters wide because it was written three characters wide.
    expect(parseNumberRanges('050')).toEqual([{ min: 50, max: 50, width: 3 }]);
    expect(parseNumberRanges('50')).toEqual([{ min: 50, max: 50 }]);
  });

  it('still refuses everything that is not a number', () => {
    expect(() => parseNumberRanges('hello')).toThrow(/invalid range/);
    expect(() => parseNumberRanges('10,,20')).toThrow(/invalid range/);
    expect(() => parseNumberRanges('1.5')).toThrow(/invalid range/);
    expect(() => parseNumberRanges('10,hello')).toThrow(/invalid range/);
  });
});

describe('number include/exclude — interval math', () => {
  it('subtracts a value, splitting the base range', () => {
    const base = parseNumberRanges('0..9');
    expect(computeAllowedIntervals(base, undefined, '3')).toEqual([
      { min: 0, max: 2 },
      { min: 4, max: 9 },
    ]);
  });

  it('subtracts a sub-range', () => {
    expect(computeAllowedIntervals(parseNumberRanges('0..100'), undefined, '40..60')).toEqual([
      { min: 0, max: 39 },
      { min: 61, max: 100 },
    ]);
  });

  it('unions include intervals then subtracts exclude last', () => {
    const allowed = computeAllowedIntervals(parseNumberRanges('0..2'), '5,7', '1');
    expect(allowed).toEqual([
      { min: 0, max: 0 },
      { min: 2, max: 2 },
      { min: 5, max: 5 },
      { min: 7, max: 7 },
    ]);
  });

  it('throws when the range is emptied', () => {
    expect(() => computeAllowedIntervals(parseNumberRanges('0..2'), undefined, '0..2')).toThrow(
      /empty after include\/exclude/,
    );
  });
});

describe('number include/exclude — generation', () => {
  it('never emits excluded values', () => {
    const out = numberGenerator({ range: '0..9', exclude: '3,7' })(200, createPrng('ex'));
    for (const v of out) expect(['3', '7']).not.toContain(v);
    for (const v of out) expect(Number(v)).toBeGreaterThanOrEqual(0);
  });

  it('is UNIFORM over remaining values (not uniform-across-ranges)', () => {
    // 0..9 exclude 3 → 9 values, each should appear ~1/9 of the time.
    // The naive [0..2],[4..9] range-list would skew 0-2 vs 4-9; verify we do
    // not: counts of {0,1,2} vs {4..9} should be proportional to their sizes.
    const N = 9000;
    const out = numberGenerator({ range: '0..9', exclude: '3' })(N, createPrng('uni'));
    const counts = new Map<string, number>();
    for (const v of out) counts.set(v, (counts.get(v) ?? 0) + 1);
    expect(counts.has('3')).toBe(false);
    // Each of the 9 values ~1000; allow generous tolerance.
    for (const digit of ['0', '1', '2', '4', '5', '6', '7', '8', '9']) {
      const c = counts.get(digit) ?? 0;
      expect(c).toBeGreaterThan(750);
      expect(c).toBeLessThan(1250);
    }
  });

  it('include adds values back', () => {
    const out = numberGenerator({ range: '0..1', include: '100' })(200, createPrng('in'));
    const seen = new Set(out);
    expect([...seen].every((v) => ['0', '1', '100'].includes(v))).toBe(true);
  });

  it('keeps leading-zero width from the base range', () => {
    const out = numberGenerator({ range: '0000..9999', exclude: '1234' })(50, createPrng('w'));
    for (const v of out) {
      expect(v).toHaveLength(4);
      expect(v).not.toBe('1234');
    }
  });

  it('errors when include/exclude are used without a range', () => {
    expect(() => numberGenerator({ exclude: '3' })(1, createPrng('x'))).toThrow(
      /require a numeric range/,
    );
  });

  it('is deterministic for the same seed', () => {
    const g = numberGenerator({ range: '1000..9999', exclude: '5000..6000' });
    expect(g(20, createPrng('det'))).toEqual(g(20, createPrng('det')));
  });
});
