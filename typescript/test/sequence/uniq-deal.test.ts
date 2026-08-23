/**
 * The deal, not the repair.
 *
 * `arrangeUnique` has two halves: a builder that assembles the rows, and a
 * repair that fixes whatever came out repeated. Only the first is cheap. The
 * repair costs time quadratic in the duplicates it is handed, and duplicates
 * grow as the SQUARE of the row count, so a builder that leaks even a fraction
 * of a percent turns a run of minutes into a run of hours — measured, on a
 * 4,000,000-row config that spent three and a half hours without writing a
 * byte.
 *
 * Both halves are correct, so the finished table cannot tell them apart: a
 * repaired table and a table that never needed repairing are both all-distinct.
 * That is why these assert `builtDistinct` — what the BUILDER reached alone.
 * Asserting `distinct` here would be a test that cannot fail.
 *
 * The shapes are not arbitrary. Each was checked against the previous builder
 * by disabling the distinct deal and re-measuring; the numbers that builder
 * produced are recorded beside each assertion. A shape both builders got right
 * would make this file decorative, and most shapes are exactly that.
 */
import { describe, expect, it } from 'vitest';

import { arrangeUnique, uniqUpperBound, valueCounts } from '../../src/sequence/uniq.js';

/** A column of `n` values drawn from `values` in the given proportions. */
function column(n: number, values: readonly string[], weights: readonly number[]): string[] {
  const out: string[] = [];
  const total = weights.reduce((a, b) => a + b, 0);
  values.forEach((v, i) => {
    const share = Math.round((n * (weights[i] ?? 0)) / total);
    for (let k = 0; k < share; k++) out.push(v);
  });
  while (out.length < n) out.push(values[values.length - 1] ?? '');
  return out.slice(0, n);
}

/** A column of `k` values in equal shares — the wide, uniform kind. */
function flat(n: number, k: number, prefix: string): string[] {
  return column(
    n,
    Array.from({ length: k }, (_, i) => `${prefix}${String(i)}`),
    Array(k).fill(1) as number[],
  );
}

const N = 4000;

describe('the uniq builder hands the repair nothing to do', () => {
  it('a wide column followed by a skewed one comes out already distinct', () => {
    /*
     * The shape that leaked. A wide first column makes many small groups; the
     * second column is skewed, so the proportional split kept handing the
     * dominant value to two rows of the SAME group — and two rows in one group
     * agree on every earlier column, so a repeat there IS a duplicate row.
     *
     * Previous builder: 3,947 of 4,000 — 53 duplicates for the repair to undo.
     */
    const columns = [
      flat(N, 800, 'a'),
      column(N, ['x', 'y', 'z', 'w', 'v'], [40, 25, 15, 12, 8]),
      column(N, ['m', 'f'], [50, 50]),
    ];

    expect(uniqUpperBound(columns.map(valueCounts))).toBe(N); // the pool allows it
    const { builtDistinct, distinct } = arrangeUnique(columns);
    expect(builtDistinct).toBe(N);
    expect(distinct).toBe(N);
  });

  it('reaches what the repair would reach, when the pool cannot cover every row', () => {
    /*
     * Here 4,000 distinct rows are impossible: three values and two, behind a
     * wide column, cap the table at 3,200. The claim is about the DEAL getting
     * there by itself.
     *
     * Previous builder: 3,100, and the repair spent its quadratic sweep
     * climbing the last hundred.
     */
    const columns = [
      flat(N, 800, 'a'),
      column(N, ['x', 'y', 'z'], [60, 25, 15]),
      column(N, ['m', 'f'], [70, 30]),
    ];

    const { builtDistinct, distinct } = arrangeUnique(columns);
    expect(builtDistinct).toBe(3200);
    expect(distinct).toBe(builtDistinct); // the repair had nothing left to add
  });

  it('when the pool truly cannot cover the rows, the repair is still what fixes it', () => {
    // 2 x 2 = 4 combinations for 10 rows. No deal can make these distinct, so
    // this pins that the builder gives up rather than pretending — and that the
    // result is still the best the pool allows.
    const columns = [column(10, ['m', 'f'], [50, 50]), column(10, ['x', 'y'], [50, 50])];

    const { builtDistinct, distinct } = arrangeUnique(columns);
    expect(builtDistinct).toBeLessThan(10);
    expect(distinct).toBe(4); // every combination the 2x2 pool has
  });

  it('every column keeps its exact multiset — the percentages do not move', () => {
    /*
     * The deal chooses WHICH row gets which value, never which values exist.
     * Without this, a builder could reach all-distinct by quietly handing out
     * values the column never drew.
     */
    const columns = [
      flat(N, 800, 'a'),
      column(N, ['x', 'y', 'z', 'w', 'v'], [40, 25, 15, 12, 8]),
      column(N, ['m', 'f'], [50, 50]),
    ];
    const tally = (col: readonly string[]): Record<string, number> => {
      const t: Record<string, number> = {};
      for (const v of col) t[v] = (t[v] ?? 0) + 1;
      return t;
    };

    const arranged = arrangeUnique(columns).columns;
    columns.forEach((original, k) => {
      expect(tally(arranged[k] ?? [])).toEqual(tally(original));
    });
  });
});
