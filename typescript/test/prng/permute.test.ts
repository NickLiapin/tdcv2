import { describe, expect, it } from 'vitest';

import { permute, permuteKey, unpermute } from '../../src/prng/permute.js';

const KEY = permuteKey('seed-1', 'field-a');

describe('permute — bijection over [0, n)', () => {
  it('is a bijection for many n, including non-powers-of-two', () => {
    for (const n of [1, 2, 3, 7, 16, 100, 255, 256, 997, 1000, 4096, 12345]) {
      const seen = new Set<number>();
      for (let i = 0; i < n; i++) {
        const s = permute(i, n, KEY);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThan(n);
        seen.add(s);
      }
      expect(seen.size).toBe(n); // every slot hit exactly once
    }
  });

  it('is deterministic (same index/n/key → same slot)', () => {
    for (let i = 0; i < 200; i++) expect(permute(i, 1000, KEY)).toBe(permute(i, 1000, KEY));
  });

  it('unpermute inverts permute', () => {
    for (const n of [7, 100, 997, 4096]) {
      const k = permuteKey('s', `n${String(n)}`);
      for (let i = 0; i < n; i++) expect(unpermute(permute(i, n, k), n, k)).toBe(i);
    }
  });

  it('different keys give different orderings', () => {
    const k1 = permuteKey('s', 'x');
    const k2 = permuteKey('s', 'y');
    let differ = 0;
    for (let i = 0; i < 1000; i++) if (permute(i, 1000, k1) !== permute(i, 1000, k2)) differ++;
    expect(differ).toBeGreaterThan(900); // almost all positions move
  });
});

describe('permute — EXACT percentages with no array ("лотерея без барабана")', () => {
  // A bijection sends exactly the first `q` indices' worth into the first `q`
  // slots, so a sorted quota plan yields byte-exact counts.
  const categoryOf = (slot: number, cumulative: readonly number[]): number => {
    for (let c = 0; c < cumulative.length; c++) if (slot < cumulative[c]!) return c;
    return cumulative.length - 1;
  };
  const distribute = (n: number, quotas: readonly number[], key: number): number[] => {
    const cumulative: number[] = [];
    let acc = 0;
    for (const q of quotas) {
      acc += q;
      cumulative.push(acc);
    }
    const counts = new Array<number>(quotas.length).fill(0);
    for (let i = 0; i < n; i++) counts[categoryOf(permute(i, n, key), cumulative)]! += 1;
    return counts;
  };

  it('70/30 over 1000 → exactly 700/300', () => {
    expect(distribute(1000, [700, 300], permuteKey('s', 'g1'))).toEqual([700, 300]);
  });

  it('50/30/20 over 1000 → exactly 500/300/200', () => {
    expect(distribute(1000, [500, 300, 200], permuteKey('s', 'g2'))).toEqual([500, 300, 200]);
  });

  it('exact even on a prime count (997 → 500/300/197)', () => {
    expect(distribute(997, [500, 300, 197], permuteKey('s', 'g3'))).toEqual([500, 300, 197]);
  });

  it('the exactness holds for any key (10 random keys)', () => {
    for (let t = 0; t < 10; t++) {
      expect(distribute(1234, [800, 434], permuteKey('s', `k${String(t)}`))).toEqual([800, 434]);
    }
  });
});
