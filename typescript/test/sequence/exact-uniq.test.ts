import { describe, expect, it } from 'vitest';

import {
  arrangeExactUniq,
  countDuplicates,
  type ExactUniqField,
  findDuplicateGroups,
  type KeyedRow,
} from '../../src/sequence/exact-uniq.js';

const keyed = (keys: readonly string[]): KeyedRow[] => keys.map((key, index) => ({ index, key }));

describe('findDuplicateGroups', () => {
  it('returns nothing when every tuple is distinct', () => {
    const rows = keyed(['a', 'b', 'c', 'd']);
    expect([...findDuplicateGroups(rows)]).toEqual([]);
    expect(countDuplicates(rows)).toBe(0);
  });

  it('groups the row indices that share a tuple key', () => {
    //             0    1    2    3    4    5
    const rows = keyed(['x', 'y', 'x', 'z', 'y', 'x']);
    // x → rows 0,2,5 ; y → rows 1,4 ; z → row 3 (not a dup)
    expect([...findDuplicateGroups(rows)]).toEqual([
      [0, 2, 5],
      [1, 4],
    ]);
    expect(countDuplicates(rows)).toBe(3); // (3-1) + (2-1)
  });

  it('scales through the external-sort disk path (tiny chunkSize)', () => {
    // 300 rows over 100 distinct keys → each key appears 3× → 100 groups of 3.
    const rows = keyed(Array.from({ length: 300 }, (_, i) => `k${String(i % 100)}`));
    const groups = [...findDuplicateGroups(rows, { chunkSize: 8 })];
    expect(groups).toHaveLength(100);
    for (const g of groups) expect(g).toHaveLength(3);
    // every row index is accounted for exactly once
    expect(groups.flat().sort((a, b) => a - b)).toEqual(Array.from({ length: 300 }, (_, i) => i));
    expect(countDuplicates(rows, { chunkSize: 8 })).toBe(200);
  });

  it('is deterministic and independent of chunk size', () => {
    const rows = keyed(Array.from({ length: 200 }, (_, i) => `k${String((i * 7) % 40)}`));
    expect([...findDuplicateGroups(rows, { chunkSize: 5 })]).toEqual([
      ...findDuplicateGroups(rows, { chunkSize: 500 }),
    ]);
  });
});

describe('arrangeExactUniq (stage 3 — exact-% construction + verify)', () => {
  const range = (n: number, prefix: string): string[] =>
    Array.from({ length: n }, (_, i) => `${prefix}${String(i)}`);

  it('ample slack: exact per-column marginals AND all tuples distinct', () => {
    // A: 70/30 over 100 ; B: one value per row → tuples unique via B.
    const fields: ExactUniqField[] = [
      { id: 'K.a', values: ['X', 'Y'], percents: [70, 30] },
      { id: 'K.b', values: range(100, 'b'), percents: range(100, 'b').map(() => 1) },
    ];
    const reg = arrangeExactUniq(fields, 100, 'seed', '"K"');
    const a = reg['K.a'];
    const b = reg['K.b'];
    expect(a?.resolve).toBeDefined();
    const aTally: Record<string, number> = {};
    const tuples = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const av = a?.resolve?.(i) ?? '';
      const bv = b?.resolve?.(i) ?? '';
      aTally[av] = (aTally[av] ?? 0) + 1;
      tuples.add(`${av}|${bv}`);
    }
    expect(aTally).toEqual({ X: 70, Y: 30 }); // exact marginal
    expect(tuples.size).toBe(100); // all distinct
  });

  it('throws a clear feasibility error when count exceeds capacity', () => {
    const fields: ExactUniqField[] = [
      { id: 'K.a', values: ['X', 'Y'], percents: [50, 50] },
      { id: 'K.b', values: ['m', 'n'], percents: [50, 50] },
    ];
    // capacity 2×2 = 4 < 10
    expect(() => arrangeExactUniq(fields, 10, 'seed', '"K"')).toThrow(/infeasible/i);
  });

  // Stage 4: tight, feasible configs collide during construction — the repair
  // must make them distinct WHILE keeping each column's exact marginal.
  it('repairs collisions: all distinct AND exact marginals preserved', () => {
    const cases: { fields: ExactUniqField[]; count: number; aExpect: Record<string, number> }[] = [
      {
        // capacity 6, count 5 — construction collides; repair to 5 distinct, A 3/2.
        fields: [
          { id: 'K.a', values: ['X', 'Y'], percents: [60, 40] },
          { id: 'K.b', values: ['0', '1', '2'], percents: [100 / 3, 100 / 3, 100 / 3] },
        ],
        count: 5,
        aExpect: { X: 3, Y: 2 },
      },
      {
        // 3-value weighted A over 20 rows, B 10 values.
        fields: [
          { id: 'K.a', values: ['X', 'Y', 'Z'], percents: [40, 30, 30] },
          {
            id: 'K.b',
            values: Array.from({ length: 10 }, (_, i) => `b${String(i)}`),
            percents: Array.from({ length: 10 }, () => 10),
          },
        ],
        count: 20,
        aExpect: { X: 8, Y: 6, Z: 6 },
      },
    ];

    for (const { fields, count, aExpect } of cases) {
      const reg = arrangeExactUniq(fields, count, 'rep', '"K"');
      const a = reg['K.a'];
      const b = reg['K.b'];
      const tuples = new Set<string>();
      const aTally: Record<string, number> = {};
      for (let i = 0; i < count; i++) {
        const av = a?.resolve?.(i) ?? '';
        const bv = b?.resolve?.(i) ?? '';
        tuples.add(`${av}|${bv}`);
        aTally[av] = (aTally[av] ?? 0) + 1;
      }
      expect(tuples.size).toBe(count); // uniqueness restored
      expect(aTally).toEqual(aExpect); // marginal preserved exactly
    }
  });
});
