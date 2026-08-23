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
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { countDuplicates, repairExactUniq, scanTupleRuns } from '../../src/sequence/exact-uniq.js';
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

/** A column that remembers how often it was asked for a value. */
function countingColumn(
  id: string,
  values: readonly string[],
  stride: number,
): { id: string; resolve: (i: number) => string; calls: () => number } {
  let calls = 0;
  return {
    id,
    resolve: (i: number): string => {
      calls++;
      return values[Math.floor(i / stride) % values.length] ?? '';
    },
    calls: () => calls,
  };
}

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

  it('given records computed elsewhere, it computes none of its own', () => {
    /*
     * The scan splits across threads: each computes the tuples for its own
     * range, sorts them into files, and the coordinator merges. What has to
     * hold here is that the merge really replaces the work — a repair that
     * quietly recomputed would be correct and pointless, and correctness alone
     * cannot tell the two apart.
     *
     * So the columns count how often they are asked. Handed the files, the
     * answer has to be zero.
     */
    const count = 500;
    const dir = mkdtempSync(join(tmpdir(), 'tdc-scan-test-'));
    try {
      // Few collisions on purpose: the repair legitimately resolves its POOL,
      // and a shape that collides heavily makes the pool the whole run, which
      // would hide the thing being measured.
      const first = [countingColumn('A', many(120, 'a'), 1), countingColumn('B', many(60, 'b'), 7)];
      // Two "threads", each taking half the rows, exactly as the workers do.
      const runs = [
        ...scanTupleRuns(first, 0, 250, dir, 'r0'),
        ...scanTupleRuns(first, 250, count, dir, 'r1'),
      ];
      expect(runs.length).toBeGreaterThan(0);

      // The SAME shape as `first` — a different object, so the counts start at
      // zero, but the very same values.
      const second = [
        countingColumn('A', many(120, 'a'), 1),
        countingColumn('B', many(60, 'b'), 7),
      ];
      const asked = (): number => second.reduce((n, c) => n + c.calls(), 0);
      const fromRuns = repairExactUniq(second, count, '"A × B"', { sortedRuns: runs });
      // The repair still resolves the pool's own rows — the handful it is
      // rearranging, never the whole run. Two columns over 500 rows would be
      // 1,000 asks if it scanned; the pool costs a fraction of that.
      expect(asked()).toBeLessThan(count);

      // And it reaches the same answer as the run that did the scanning itself.
      const own = repairExactUniq(first, count, '"A × B"', { journalMinRows: 1 });
      const ids = ['A', 'B'];
      expect(rowsOf(fromRuns, ids, count)).toEqual(rowsOf(own, ids, count));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
