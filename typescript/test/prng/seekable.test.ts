import { describe, expect, it } from 'vitest';

import {
  openUnit,
  seekableFloat,
  seekableGen,
  seekableInt,
  seekableUniforms,
} from '../../src/prng/seekable.js';

describe('openUnit — map a [0,1) draw into the open interval (0,1)', () => {
  it('never returns 0 or 1 (so ln/pow in inverse-CDF stay finite)', () => {
    expect(openUnit(0)).toBeGreaterThan(0);
    expect(openUnit(0)).toBeLessThan(1);
    // the largest value sfc32 can emit is (2^32 - 1)/2^32 — must stay < 1
    expect(openUnit((4294967296 - 1) / 4294967296)).toBeLessThan(1);
    expect(openUnit(1)).toBeLessThan(1); // defensive clamp for any caller
  });

  it('barely perturbs a typical draw', () => {
    expect(openUnit(0.5)).toBeCloseTo(0.5, 9);
  });
});

describe('seekableUniforms — N open-interval draws for a row', () => {
  it('is deterministic per (seed, streamId, index, count) and has the right length', () => {
    const a = seekableUniforms('s', 'X', 5, 3);
    expect(a).toEqual(seekableUniforms('s', 'X', 5, 3));
    expect(a).toHaveLength(3);
  });

  it('is independent per row index and per streamId', () => {
    expect(seekableUniforms('s', 'X', 5, 2)).not.toEqual(seekableUniforms('s', 'X', 6, 2));
    expect(seekableUniforms('s', 'X', 5, 2)).not.toEqual(seekableUniforms('s', 'Y', 5, 2));
  });

  it('every draw is strictly inside (0,1)', () => {
    for (let i = 0; i < 500; i++) {
      for (const u of seekableUniforms('s', 'X', i, 2)) {
        expect(u).toBeGreaterThan(0);
        expect(u).toBeLessThan(1);
      }
    }
  });
});

describe('seekable PRNG — jump to any row without iterating', () => {
  it('is deterministic per (seed, streamId, index)', () => {
    expect(seekableFloat('s', 'name', 42)).toBe(seekableFloat('s', 'name', 42));
    expect(seekableInt('s', 'name', 42, 100)).toBe(seekableInt('s', 'name', 42, 100));
  });

  it('depends on all of seed, streamId, and index', () => {
    const base = seekableFloat('s', 'name', 42);
    expect(seekableFloat('other', 'name', 42)).not.toBe(base);
    expect(seekableFloat('s', 'age', 42)).not.toBe(base);
    expect(seekableFloat('s', 'name', 43)).not.toBe(base);
  });

  it('floats are in [0, 1) and ints in [0, n)', () => {
    for (let i = 0; i < 500; i++) {
      const f = seekableFloat('s', 'f', i);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      const n = seekableInt('s', 'f', i, 7);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(7);
    }
  });

  it('is roughly uniform across independent indices', () => {
    let sum = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) sum += seekableFloat('s', 'u', i);
    expect(sum / N).toBeGreaterThan(0.47);
    expect(sum / N).toBeLessThan(0.53); // mean near 0.5
  });

  it('seekableInt spreads across all buckets', () => {
    const buckets = new Array<number>(10).fill(0);
    for (let i = 0; i < 10000; i++) buckets[seekableInt('s', 'b', i, 10)]! += 1;
    for (const c of buckets) expect(c).toBeGreaterThan(700); // ~1000 each, no empty bucket
  });

  it('seekableGen yields a repeatable multi-draw stream per index', () => {
    const a = seekableGen('s', 'g', 3);
    const b = seekableGen('s', 'g', 3);
    for (let k = 0; k < 5; k++) expect(a()).toBe(b());
  });
});
