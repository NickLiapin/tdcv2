import { describe, expect, it } from 'vitest';

import { createPrng } from '../../src/prng/prng.js';
import { randomInt, randomPick, shuffle } from '../../src/prng/random.js';

describe('randomInt', () => {
  it('returns integer inside [min, max)', () => {
    const prng = createPrng('range-test');
    for (let i = 0; i < 100; i++) {
      const n = randomInt(prng, 10, 20);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(10);
      expect(n).toBeLessThan(20);
    }
  });

  it('is deterministic with a seeded prng', () => {
    const a = createPrng('x');
    const b = createPrng('x');
    for (let i = 0; i < 10; i++) {
      expect(randomInt(a, 0, 1000)).toBe(randomInt(b, 0, 1000));
    }
  });

  it('matches golden vector from 2022-2024 prototype (seed "hello", 0..100)', () => {
    // Reference: old Generator.randomNumberMinMax(0, 100) with seed "hello".
    const prng = createPrng('hello');
    const expected = [96, 72, 93, 71, 89, 85, 82, 47, 32, 28];
    for (const v of expected) {
      expect(randomInt(prng, 0, 100)).toBe(v);
    }
  });

  it('supports negative min (e.g. -10..10)', () => {
    const prng = createPrng('neg');
    for (let i = 0; i < 100; i++) {
      const n = randomInt(prng, -10, 10);
      expect(n).toBeGreaterThanOrEqual(-10);
      expect(n).toBeLessThan(10);
    }
  });
});

describe('randomPick', () => {
  it('returns an element from the provided array', () => {
    const prng = createPrng('pick-test');
    const arr = ['a', 'b', 'c', 'd'] as const;
    for (let i = 0; i < 50; i++) {
      expect(arr).toContain(randomPick(prng, arr));
    }
  });

  it('matches golden vector from 2022-2024 prototype', () => {
    // Reference: old randomDataFromArray(['a','b','c','d','e']) with seed "hello".
    const prng = createPrng('hello');
    const expected = ['e', 'd', 'e', 'd', 'e'];
    for (const v of expected) {
      expect(randomPick(prng, ['a', 'b', 'c', 'd', 'e'])).toBe(v);
    }
  });

  it('is deterministic with a seeded prng', () => {
    const items = ['w', 'x', 'y', 'z'];
    const a = createPrng('deterministic');
    const b = createPrng('deterministic');
    for (let i = 0; i < 20; i++) {
      expect(randomPick(a, items)).toBe(randomPick(b, items));
    }
  });
});

describe('shuffle', () => {
  it('returns a permutation (same length, same multiset)', () => {
    const prng = createPrng('shuffle');
    const input = [1, 2, 3, 4, 5, 6, 7];
    const out = shuffle(prng, input);
    expect(out).toHaveLength(input.length);
    expect([...out].sort((a, b) => a - b)).toEqual([...input].sort((a, b) => a - b));
  });

  it('does not mutate the input array', () => {
    const input = [1, 2, 3, 4, 5];
    const snapshot = [...input];
    const prng = createPrng('no-mutate');
    shuffle(prng, input);
    expect(input).toEqual(snapshot);
  });

  it.each([
    {
      seed: '674teyer74yTRGY7',
      expected: ['f', 'c', 'b', 'i', 'j', 'h', 'e', 'g', 'a', 'd'],
    },
    { seed: 'hello', expected: ['c', 'a', 'b', 'd', 'e', 'i', 'f', 'h', 'g', 'j'] },
    { seed: 'tdc-test-seed', expected: ['h', 'j', 'a', 'd', 'c', 'i', 'e', 'g', 'f', 'b'] },
    { seed: 'abc', expected: ['h', 'j', 'c', 'd', 'e', 'f', 'a', 'i', 'b', 'g'] },
  ])('matches golden vector for seed $seed', ({ seed, expected }) => {
    const prng = createPrng(seed);
    const out = shuffle(prng, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
    expect(out).toEqual(expected);
  });

  it('empty array round-trips to empty array', () => {
    const prng = createPrng('empty');
    expect(shuffle(prng, [])).toEqual([]);
  });

  it('single-element array round-trips unchanged', () => {
    const prng = createPrng('single');
    expect(shuffle(prng, [42])).toEqual([42]);
  });
});
