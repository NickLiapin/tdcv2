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
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  countDuplicates,
  repairExactUniq,
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
  });
});
