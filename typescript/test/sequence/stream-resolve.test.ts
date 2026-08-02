import { describe, expect, it } from 'vitest';

import { computeCountsPerValue } from '../../src/distribution/index.js';
import { createPrng } from '../../src/prng/index.js';
import { permuteKey } from '../../src/prng/permute.js';
import {
  counterValueAt,
  percentValueAt,
  uniformValueAt,
} from '../../src/sequence/stream-resolve.js';

describe('streaming resolvers — exact percent (лотерея без барабана)', () => {
  it('two-way 70/30 over 100 rows → exactly 70/30, no array', () => {
    const values = ['A', 'B'];
    const count = 100;
    const counts = computeCountsPerValue(count, [70, 30], createPrng('t')); // [70, 30]
    const key = permuteKey('seed', 'field');
    const tally: Record<string, number> = {};
    for (let i = 0; i < count; i++) {
      const v = percentValueAt(values, counts, count, key, i);
      tally[v] = (tally[v] ?? 0) + 1;
    }
    expect(tally).toEqual({ A: 70, B: 30 });
  });

  it('three-way on a prime count matches Hamilton exactly (997 = 50/30/20)', () => {
    const values = ['x', 'y', 'z'];
    const count = 997;
    const counts = computeCountsPerValue(count, [50, 30, 20], createPrng('t'));
    const key = permuteKey('s', 'f');
    const tally = [0, 0, 0];
    for (let i = 0; i < count; i++) {
      const idx = values.indexOf(percentValueAt(values, counts, count, key, i));
      tally[idx] = (tally[idx] ?? 0) + 1;
    }
    expect(tally).toEqual(counts);
    expect(tally.reduce((a, b) => a + b, 0)).toBe(count);
  });

  it('is deterministic', () => {
    const counts = computeCountsPerValue(50, [50, 50], createPrng('t'));
    const key = permuteKey('s', 'f');
    for (let i = 0; i < 50; i++) {
      expect(percentValueAt(['A', 'B'], counts, 50, key, i)).toBe(
        percentValueAt(['A', 'B'], counts, 50, key, i),
      );
    }
  });
});

describe('streaming resolvers — uniform pick + counters', () => {
  it('uniformValueAt picks from the list, deterministically, spread out', () => {
    const values = ['a', 'b', 'c', 'd'];
    const tally: Record<string, number> = {};
    for (let i = 0; i < 4000; i++) {
      const v = uniformValueAt(values, 's', 'f', i);
      expect(values).toContain(v);
      tally[v] = (tally[v] ?? 0) + 1;
    }
    for (const v of values) expect(tally[v] ?? 0).toBeGreaterThan(800); // ~1000 each
    expect(uniformValueAt(values, 's', 'f', 7)).toBe(uniformValueAt(values, 's', 'f', 7));
  });

  it('counterValueAt is a pure function of i', () => {
    expect(counterValueAt('increment', 100, 5, 0)).toBe(100);
    expect(counterValueAt('increment', 100, 5, 3)).toBe(115);
    expect(counterValueAt('decrement', 100, 2, 4)).toBe(92);
  });
});
