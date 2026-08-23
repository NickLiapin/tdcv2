/**
 * The repair reads the tuples it already computed, instead of computing them
 * twice.
 *
 * Finding the collisions means deriving every row's tuple. Learning which
 * tuples are already taken means deriving every row's tuple AGAIN — and on a
 * 97,000,000-row run that second derivation was 18 minutes on top of the 23 the
 * first one took. The scan now writes what it computed to a file and the repair
 * reads it back, which turns those 18 minutes into a sequential read.
 *
 * The two paths must agree exactly. They are asked the same question in a
 * different order — the file is in sorted order, the derivation in row order —
 * and the answer is a membership test, which does not care. These tests are
 * what says so rather than assuming it, by running the same config both ways
 * and comparing the result row by row.
 *
 * The threshold is lowered here on purpose. Left alone the file path only ever
 * runs on a config far too large for a test suite, which is exactly how a code
 * path comes to be believed instead of known.
 */
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { countDuplicates, repairExactUniq } from '../../src/sequence/exact-uniq.js';
import type { Sequence } from '../../src/sequence/index.js';

/** A resolver whose value for row `i` is a pure function of `i`. */
const column = (
  id: string,
  values: readonly string[],
  stride: number,
): { id: string; resolve: (i: number) => string } => ({
  id,
  resolve: (i: number): string => values[Math.floor(i / stride) % values.length] ?? '',
});

const many = (n: number, prefix: string): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i)}`);

/** Every row's tuple, after the repair has had its say. */
function rowsOf(built: Record<string, Sequence>, ids: readonly string[], count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(ids.map((id) => built[id]?.resolve?.(i) ?? '').join('|'));
  }
  return out;
}

/** How many of the repair's temp directories exist right now. */
const tempDirCount = (): number =>
  readdirSync(tmpdir()).filter((n) => n.startsWith('tdc-uniq-')).length;

const CASES = [
  {
    name: 'a wide column and a narrow one, a dozen collisions',
    count: 300,
    columns: [column('A', many(60, 'a'), 1), column('B', many(7, 'b'), 11)],
  },
  {
    name: 'three columns, most rows already distinct',
    count: 400,
    columns: [
      column('A', many(40, 'a'), 1),
      column('B', many(5, 'b'), 13),
      column('C', many(3, 'c'), 29),
    ],
  },
  {
    name: 'two columns drawing from the same values, a quarter colliding',
    count: 300,
    columns: [column('A', many(30, 'v'), 1), column('B', many(30, 'v'), 7)],
  },
  {
    name: 'a run where a quarter of the rows have to move',
    count: 500,
    columns: [column('A', many(100, 'a'), 1), column('B', many(9, 'b'), 17)],
  },
];

describe('the repair reads back what the scan computed', () => {
  for (const c of CASES) {
    it(`${c.name}: the file path and the derive path agree`, () => {
      const ids = c.columns.map((r) => r.id);
      const label = `"${ids.join(' × ')}"`;

      // There is something to repair. Without this the comparison below could
      // be two copies of an untouched table agreeing about nothing.
      const tuples = function* (): Generator<{ index: number; key: string }> {
        for (let i = 0; i < c.count; i++) {
          yield {
            index: i,
            key: c.columns.map((col) => col.resolve(i)).join(String.fromCharCode(1)),
          };
        }
      };
      expect(countDuplicates(tuples())).toBeGreaterThan(0);

      // Derived twice, as it was before the file existed.
      const derived = repairExactUniq(c.columns, c.count, label, {
        journalMinRows: Number.MAX_SAFE_INTEGER,
      });
      // Written down once and read back — the path a large run takes.
      const journalled = repairExactUniq(c.columns, c.count, label, { journalMinRows: 1 });

      const a = rowsOf(derived, ids, c.count);
      const b = rowsOf(journalled, ids, c.count);
      expect(b).toEqual(a);

      // The repair did its job in both: every row distinct.
      expect(new Set(a).size).toBe(c.count);
    });
  }

  it('leaves no temp files behind', () => {
    /*
     * The file lives in the system temp directory and is removed on every way
     * out of the repair — the clean run that finds nothing to fix, and the
     * ordinary one that fixes something. A run that leaves them behind fills a
     * disk quietly over a week.
     */
    const before = tempDirCount();

    // Nothing to repair: 200 x 200 values over 200 rows, all distinct already.
    repairExactUniq(
      [column('A', many(200, 'a'), 1), column('B', many(200, 'b'), 1)],
      200,
      '"A × B"',
      { journalMinRows: 1 },
    );
    // Something to repair.
    const c = CASES[0];
    if (c) repairExactUniq(c.columns, c.count, '"A × B"', { journalMinRows: 1 });

    expect(tempDirCount()).toBe(before);
  });
});
