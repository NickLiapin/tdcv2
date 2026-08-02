import { describe, expect, it } from 'vitest';

import { computeCountsPerValue, distributeByPercent } from '../../src/distribution/hamilton.js';
import { createPrng } from '../../src/prng/prng.js';

describe('computeCountsPerValue — mathematical invariants', () => {
  it('counts sum to the requested total for any clean percent split', () => {
    const prng = createPrng('clean');
    const counts = computeCountsPerValue(100, [60, 40], prng);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(counts).toEqual([60, 40]);
  });

  it('distributes exact counts when percents divide evenly', () => {
    const prng = createPrng('anyseed');
    const counts = computeCountsPerValue(10, [30, 50, 20], prng);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(10);
    expect(counts[0]).toBe(3);
    expect(counts[1]).toBe(5);
    expect(counts[2]).toBe(2);
  });

  it('allocates remainders when percents do not divide evenly', () => {
    // 7 cells, three values of 33.33% / 33.33% / 33.34% — sum is 100.
    // Each rawCells ≈ 2.333 / 2.333 / 2.3338, truncated to 2/2/2 = 6.
    // One cell remains; the largest fractional remainder (value index 2)
    // takes it.
    const prng = createPrng('any');
    const counts = computeCountsPerValue(7, [33.33, 33.33, 33.34], prng);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(7);
    expect(counts[2]).toBe(3);
    expect(counts[0]).toBe(2);
    expect(counts[1]).toBe(2);
  });

  it('is deterministic with a seeded prng', () => {
    const a = computeCountsPerValue(1000, [17, 33, 50], createPrng('same'));
    const b = computeCountsPerValue(1000, [17, 33, 50], createPrng('same'));
    expect(a).toEqual(b);
  });

  it('sum invariance holds for a large count with fractional percents', () => {
    const prng = createPrng('large');
    const counts = computeCountsPerValue(1_000_000, [42.7, 57.3], prng);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1_000_000);
  });
});

describe('distributeByPercent — bit-identical vs 2022-2024 prototype', () => {
  // Reference outputs captured by running the old
  // Generator.allocateDataByPercentage with the exact same inputs and seed.

  it('allocate(100, [M,W], [42,58]) with seed 674teyer74yTRGY7 — first 20 match', () => {
    const prng = createPrng('674teyer74yTRGY7');
    const out = distributeByPercent({
      count: 100,
      values: ['M', 'W'],
      percents: [42, 58],
      prng,
    });
    const firstTwenty = out.slice(0, 20);
    expect(firstTwenty).toEqual([
      'M',
      'M',
      'M',
      'M',
      'W',
      'W',
      'M',
      'M',
      'W',
      'M',
      'M',
      'M',
      'W',
      'W',
      'W',
      'M',
      'W',
      'M',
      'M',
      'W',
    ]);
    // Invariants for full 100-cell result
    expect(out).toHaveLength(100);
    expect(out.filter((v) => v === 'M')).toHaveLength(42);
    expect(out.filter((v) => v === 'W')).toHaveLength(58);
  });

  it('allocate(10, [X,Y,Z], [30,50,20]) with seed 674teyer74yTRGY7 — full match', () => {
    const prng = createPrng('674teyer74yTRGY7');
    const out = distributeByPercent({
      count: 10,
      values: ['X', 'Y', 'Z'],
      percents: [30, 50, 20],
      prng,
    });
    expect(out).toEqual(['Y', 'X', 'X', 'Z', 'Z', 'Y', 'Y', 'Y', 'X', 'Y']);
  });

  it('allocate(7, [A,B,C], fractional percents) with seed hello — full match', () => {
    const prng = createPrng('hello');
    const out = distributeByPercent({
      count: 7,
      values: ['A', 'B', 'C'],
      percents: [33.33, 33.33, 33.34],
      prng,
    });
    expect(out).toEqual(['A', 'A', 'B', 'B', 'C', 'C', 'C']);
  });
});

describe('distributeByPercent — API behaviour', () => {
  it('returns a new array (does not mutate inputs)', () => {
    const values = ['x', 'y'];
    const snapshot = [...values];
    const prng = createPrng('immut');
    distributeByPercent({ count: 10, values, percents: [50, 50], prng });
    expect(values).toEqual(snapshot);
  });

  it('handles a single value with 100% (returns `count` copies)', () => {
    const prng = createPrng('single');
    const out = distributeByPercent({
      count: 5,
      values: ['only'],
      percents: [100],
      prng,
    });
    expect(out).toEqual(['only', 'only', 'only', 'only', 'only']);
  });
});

/**
 * Scale. The remainder hand-out used to rescan the whole array per leftover
 * cell and, worse, called `Math.max(...fracRemainders)` — spreading every value
 * as an argument. At 160 000 values (the size of the US census surname list)
 * that overflowed the call stack, so a weighted surname pack could not have
 * worked at all. Measured before the fix: 50 000 values took 0.47s and 160 000
 * threw outright.
 */
describe('computeCountsPerValue at list-pack scale', () => {
  /** One common value and a long tail of rare ones — the shape real data has. */
  const skewed = (n: number): number[] =>
    Array.from({ length: n }, (_, i) => (i === 0 ? 2 : 98 / (n - 1)));

  const prng = () => 0.5;

  for (const n of [30_000, 160_000]) {
    it(`handles ${String(n)} values without overflowing the stack`, () => {
      const counts = computeCountsPerValue(1000, skewed(n), prng);
      expect(counts).toHaveLength(n);
      // The invariant that matters: the cells still add up exactly.
      expect(counts.reduce((a, b) => a + b, 0)).toBe(1000);
      expect(counts.every((c) => c >= 0)).toBe(true);
    });
  }

  it('stays fast enough to be usable on a real pack', () => {
    const started = Date.now();
    computeCountsPerValue(1000, skewed(160_000), prng);
    // Generous: the point is that it is no longer quadratic, not a benchmark.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('gives the most common value its full share even in a huge list', () => {
    // 2 percent of 1000 rows is 20, regardless of how long the tail is.
    const counts = computeCountsPerValue(1000, skewed(160_000), prng);
    expect(counts[0]).toBe(20);
  });
});
