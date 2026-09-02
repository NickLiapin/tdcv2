/**
 * The fingerprint repair against the text repair — same table, or no deal.
 *
 * Engine 5 changes the CARRIER: 13-byte hashes instead of tuple text, sorted
 * as packed integers, queried by binary search on disk. Which rows collide and
 * where they move must not change with the carrier. These cases run the same
 * columns through both paths and compare every row.
 *
 * The one place the two may legitimately differ is a 64-bit hash collision
 * during a ledger query — odds around 5e-6 for a ten-million-row run, and the
 * difference is an extra avoidance, never a duplicate. At these test sizes the
 * odds are astronomically small, so byte equality is asserted outright.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  countDuplicates,
  repairExactUniq,
  ExactUniqRepairNeeded,
  verifyCandidates,
} from '../../src/sequence/exact-uniq.js';

import type { Sequence } from '../../src/sequence/index.js';

const JOIN = String.fromCharCode(1);

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

function rowsOf(built: Record<string, Sequence>, ids: readonly string[], count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++)
    out.push(ids.map((id) => built[id]?.resolve?.(i) ?? '').join('|'));
  return out;
}

const CASES = [
  {
    name: 'a wide column and a narrow one, hundreds of collisions',
    count: 3000,
    columns: [column('A', many(200, 'a'), 1), column('B', many(25, 'b'), 11)],
  },
  {
    name: 'three columns, collisions in quantity',
    count: 2000,
    columns: [
      column('A', many(50, 'a'), 1),
      column('B', many(20, 'b'), 13),
      column('C', many(6, 'c'), 29),
    ],
  },
  {
    name: 'two columns drawing from one list',
    count: 1500,
    columns: [column('A', many(60, 'v'), 1), column('B', many(60, 'v'), 11)],
  },
];

describe('fingerprints find and fix what text finds and fixes', () => {
  for (const c of CASES) {
    it(`${c.name}: identical tables, several pile counts`, () => {
      const ids = c.columns.map((col) => col.id);
      const label = `"${ids.join(' × ')}"`;

      // There is something to repair, counted by the text scan.
      const tuples = function* (): Generator<{ index: number; key: string }> {
        for (let i = 0; i < c.count; i++) {
          yield { index: i, key: c.columns.map((col) => col.resolve(i)).join(JOIN) };
        }
      };
      expect(countDuplicates(tuples())).toBeGreaterThan(0);

      const text = rowsOf(repairExactUniq(c.columns, c.count, label), ids, c.count);
      expect(new Set(text).size).toBe(c.count); // the text repair did its job

      for (const buckets of [2, 8, 32]) {
        const printed = rowsOf(
          repairExactUniq(c.columns, c.count, label, { fingerprintBuckets: buckets }),
          ids,
          c.count,
        );
        expect(printed).toEqual(text);
      }
    });
  }

  it('a hash collision between DIFFERENT tuples never becomes a duplicate', () => {
    /*
     * The property verification exists for, pinned directly — because at test
     * sizes real 64-bit collisions do not happen, and an end-to-end poison run
     * proved it: verification was disabled outright and every comparison above
     * still passed. Only a forged candidate group can make this fail, so one
     * is forged: rows whose tuples DIFFER, handed to verification as if their
     * hashes had collided.
     */
    const resolvers = [
      { id: 'A', resolve: (i: number): string => `a${String(i)}` }, // all distinct
      { id: 'B', resolve: (i: number): string => (i === 1 || i === 2 ? 'same' : `b${String(i)}`) },
    ];
    // Rows 5 and 6: different tuples "colliding" — no duplicate may come out.
    expect(verifyCandidates(resolvers, [[5, 6]])).toEqual([]);
    // Rows 1 and 2 share ONLY column B; tuples still differ through A.
    expect(verifyCandidates(resolvers, [[1, 2, 9]])).toEqual([]);
    // And a genuine repeat inside a mixed group survives, lowest row spared.
    const twin = [
      { id: 'A', resolve: (i: number): string => (i === 3 || i === 7 ? 'x' : `a${String(i)}`) },
      { id: 'B', resolve: (i: number): string => (i === 3 || i === 7 ? 'y' : `b${String(i)}`) },
    ];
    expect(verifyCandidates(twin, [[3, 7, 12]])).toEqual([7]);
  });

  it('a run with nothing to repair passes through untouched', () => {
    const columns = [column('A', many(400, 'a'), 1), column('B', many(400, 'b'), 1)];
    const built = repairExactUniq(columns, 400, '"A × B"', { fingerprintBuckets: 8 });
    const rows = rowsOf(built, ['A', 'B'], 400);
    expect(new Set(rows).size).toBe(400);
    // Untouched means untouched: every row still holds what it drew.
    for (let i = 0; i < 400; i++) {
      expect(rows[i]).toBe(`${columns[0]?.resolve(i) ?? ''}|${columns[1]?.resolve(i) ?? ''}`);
    }
  });

  it('leaves no fingerprint temp directories behind', () => {
    /*
     * In a private temp root, not the machine's.
     *
     * The sort spills to `mkdtemp(tmpdir(), 'tdc-fp-sort-')`, and vitest runs
     * test files in parallel processes — so counting `tdc-fp-` directories in
     * the shared temp folder counted another worker's live sort as this test's
     * leak, and this test failed in both directions depending on which worker
     * was mid-run. `os.tmpdir()` reads TMPDIR on every call, so redirecting it
     * here moves the implementation and the count together, into a directory
     * nothing else can touch.
     */
    const previousTmp = process.env['TMPDIR'];
    const root = mkdtempSync(join(tmpdir(), 'tdc-fp-test-'));
    process.env['TMPDIR'] = root;
    try {
      leavesNothingBehind();
    } finally {
      if (previousTmp === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = previousTmp;
      rmSync(root, { recursive: true, force: true });
    }
  });

  function leavesNothingBehind(): void {
    const countDirs = (): number =>
      readdirSync(tmpdir()).filter((n) => n.startsWith('tdc-fp-')).length;

    const before = countDirs();
    const c = CASES[0];
    if (c) {
      repairExactUniq(c.columns, c.count, '"A × B"', { fingerprintBuckets: 8 }); // repaired
    }
    repairExactUniq(
      [column('A', many(300, 'a'), 1), column('B', many(300, 'b'), 1)],
      300,
      '"A × B"',
      {
        fingerprintBuckets: 4,
      },
    ); // clean
    expect(countDirs()).toBe(before);
  }
  /*
   * The scan that finds repeats stops as soon as it is past the cap, because
   * nothing it could find afterwards changes the answer — on a config that
   * misses the cap by two orders of magnitude that was 6.79 s of counting
   * against 0.08 s of stopping. What it gives up is the exact figure, so the
   * sentence has to stop claiming one. The wording is shared by five
   * implementations; this pins both halves of it.
   */
  it('names the count as a floor when the verify stopped at the cap', () => {
    expect(new ExactUniqRepairNeeded(20_000, '"A × B"', true).message).toBe(
      'uniq "A × B" is too tight to repair without holding the whole table ' +
        '(more than 20000 rows couldn\'t be placed) — run without mode="stream" ' +
        'so the in-memory engine can arrange it.',
    );
  });

  it('names it exactly when the count is exact', () => {
    expect(new ExactUniqRepairNeeded(1, '"A × B"').message).toBe(
      'uniq "A × B" is too tight to repair without holding the whole table ' +
        '(1 row(s) couldn\'t be placed) — run without mode="stream" ' +
        'so the in-memory engine can arrange it.',
    );
  });

  it('stops the verify once the excess is past the point it is asked to stop at', () => {
    // Ten groups of two identical rows: nine would be found without the stop.
    const rows = Array.from({ length: 20 }, (_, i) => Math.floor(i / 2));
    const resolvers = [
      { id: 'A', name: 'A', values: [], resolve: (i: number) => `a${String(rows[i] ?? 0)}` },
    ];
    const candidates = Array.from({ length: 10 }, (_, g) => [g * 2, g * 2 + 1]);
    expect(verifyCandidates(resolvers, candidates)).toHaveLength(10);
    expect(verifyCandidates(resolvers, candidates, undefined, 3)).toHaveLength(4);
  });
});
