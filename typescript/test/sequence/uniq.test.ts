import { describe, expect, it } from 'vitest';

import {
  arrangeUnique,
  uniqCapacity,
  uniqUpperBound,
  valueCounts,
} from '../../src/sequence/uniq.js';

// --- brute-force oracle: the exact maximum distinct tuples (ground truth) ---
// Row order is a global relabel, so WLOG fix column 0 and enumerate all
// distinct permutations of the rest. Small inputs only.
function countMap(col: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of col) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}
function distinctPermutations(arr: string[]): string[][] {
  const c = countMap(arr);
  const items = [...c.keys()];
  const n = arr.length;
  const res: string[][] = [];
  const cur: string[] = [];
  const rec = (): void => {
    if (cur.length === n) {
      res.push(cur.slice());
      return;
    }
    for (const it of items) {
      const k = c.get(it)!;
      if (k > 0) {
        c.set(it, k - 1);
        cur.push(it);
        rec();
        cur.pop();
        c.set(it, k);
      }
    }
  };
  rec();
  return res;
}
function bruteMaxDistinct(cols: string[][]): number {
  const N = cols[0]!.length;
  const K = cols.length;
  const c0 = cols[0]!;
  const perms = cols.slice(1).map(distinctPermutations);
  let best = 0;
  const sel: string[][] = new Array(K - 1);
  const count = (): number => {
    const s = new Set<string>();
    for (let j = 0; j < N; j++) {
      let key = c0[j]!;
      for (let c = 0; c < K - 1; c++) key += ' ' + sel[c]![j]!;
      s.add(key);
    }
    return s.size;
  };
  const rec = (c: number): void => {
    if (c === K - 1) {
      const d = count();
      if (d > best) best = d;
      return;
    }
    for (const p of perms[c]!) {
      sel[c] = p;
      rec(c + 1);
    }
  };
  rec(0);
  return best;
}

// deterministic random small instances
let seed = 20260714;
const rnd = (): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const ri = (a: number, b: number): number => a + Math.floor(rnd() * (b - a + 1));
function randCols(): string[][] {
  const N = ri(4, 6);
  const K = ri(2, 3);
  const cols: string[][] = [];
  for (let k = 0; k < K; k++) {
    const nv = ri(1, 3);
    const cuts = [0, N];
    for (let i = 0; i < nv - 1; i++) cuts.push(ri(1, N - 1));
    cuts.sort((a, b) => a - b);
    const col: string[] = [];
    for (let i = 0; i < nv; i++) {
      const c = cuts[i + 1]! - cuts[i]!;
      for (let j = 0; j < c; j++) col.push(String.fromCharCode(97 + k * 5 + i));
    }
    while (col.length < N) col.push(String.fromCharCode(97 + k * 5));
    cols.push(col);
  }
  return cols;
}
const multiset = (col: string[]): string => [...col].sort().join(',');
const tuplesOf = (columns: string[][]): Set<string> => {
  const N = columns[0]!.length;
  const s = new Set<string>();
  for (let j = 0; j < N; j++) s.add(columns.map((c) => c[j]!).join(' '));
  return s;
};

const REFERENCE = [
  Array.from('aaaaabbbbb'),
  Array.from('ccccccdddd'),
  Array.from('fffffffeee'),
  Array.from('hhhhhhhhgg'),
];

describe('uniq core — reference example (Nick 5/5, 6/4, 7/3, 8/2)', () => {
  it('the true maximum is 9, and the builder reaches it', () => {
    const counts = REFERENCE.map(valueCounts);
    expect(bruteMaxDistinct(REFERENCE)).toBe(9); // ground truth
    expect(arrangeUnique(REFERENCE).distinct).toBe(9); // builder + repair hits it
    expect(uniqUpperBound(counts)).toBe(9); // proven upper bound, tight here
    // The data-free simulation is a SAFE lower bound (pre-repair) — here 8,
    // never above what the builder achieves. Never over-promises.
    const cap = uniqCapacity(counts);
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThanOrEqual(9);
  });
});

describe('uniq core — invariants over random small cases', () => {
  it('arrangeUnique preserves every column multiset (percentages intact)', () => {
    for (let t = 0; t < 400; t++) {
      const cols = randCols();
      const out = arrangeUnique(cols).columns;
      expect(out).toHaveLength(cols.length);
      for (let k = 0; k < cols.length; k++) expect(multiset(out[k]!)).toBe(multiset(cols[k]!));
    }
  });

  it('the reported distinct count equals the true number of distinct tuples', () => {
    for (let t = 0; t < 400; t++) {
      const cols = randCols();
      const r = arrangeUnique(cols);
      expect(tuplesOf(r.columns).size).toBe(r.distinct);
    }
  });
});

describe('uniq core — bounds are SAFE (validated vs brute force)', () => {
  it('uniqUpperBound never undercounts the true optimum (safe reject)', () => {
    for (let t = 0; t < 600; t++) {
      const cols = randCols();
      expect(uniqUpperBound(cols.map(valueCounts))).toBeGreaterThanOrEqual(bruteMaxDistinct(cols));
    }
  });

  it('uniqCapacity never over-promises: capacity ≤ built ≤ optimum', () => {
    for (let t = 0; t < 600; t++) {
      const cols = randCols();
      const cap = uniqCapacity(cols.map(valueCounts));
      const built = arrangeUnique(cols).distinct;
      const opt = bruteMaxDistinct(cols);
      expect(cap).toBeLessThanOrEqual(built);
      expect(built).toBeLessThanOrEqual(opt); // builder is never "impossible"
    }
  });
});

describe('uniq core — builder quality + data-free feasibility', () => {
  it('builder reaches the true optimum on the vast majority of cases', () => {
    let total = 0;
    let atOptimum = 0;
    for (let t = 0; t < 800; t++) {
      const cols = randCols();
      total++;
      if (arrangeUnique(cols).distinct === bruteMaxDistinct(cols)) atOptimum++;
    }
    expect(atOptimum / total).toBeGreaterThanOrEqual(0.97);
  });

  it('uniqCapacity certifies feasibility from quota numbers alone (early exit)', () => {
    // 50 values × 2 copies each per column, N=100 → all 100 tuples achievable.
    const plentiful = [new Array<number>(50).fill(2), new Array<number>(50).fill(2)];
    expect(uniqCapacity(plentiful, 100)).toBeGreaterThanOrEqual(100);
    // one single-value column → only one possible tuple.
    expect(uniqCapacity([[100], [100]])).toBe(1);
  });
});
