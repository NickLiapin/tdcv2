/**
 * Splitting the tuples into piles must change the speed and nothing else.
 *
 * A duplicate pair always lands in the same pile, because the pile is chosen by
 * a hash of the tuple and equal tuples hash equally. So the same collisions are
 * found, the same rows move, and the finished table is the same table. If that
 * ever stopped being true, Engine 4 would not be a faster Engine 3 — it would
 * be a different answer wearing the same name.
 */
import { describe, expect, it } from 'vitest';

import { bucketCountFor, bucketOf } from '../../src/sequence/bucket-uniq.js';
import { countDuplicates, repairExactUniq } from '../../src/sequence/exact-uniq.js';

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

function tuples(
  columns: readonly { resolve: (i: number) => string }[],
  count: number,
): { index: number; key: string }[] {
  const out: { index: number; key: string }[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ index: i, key: columns.map((c) => c.resolve(i)).join(JOIN) });
  }
  return out;
}

function rowsOf(built: Record<string, Sequence>, ids: readonly string[], count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++)
    out.push(ids.map((id) => built[id]?.resolve?.(i) ?? '').join('|'));
  return out;
}

const CASES = [
  {
    // 200 x 25 covers 3,000 rows with room to spare, and the strides make 800
    // of them collide — measured, not guessed. A shape with no collisions would
    // make the comparison two copies of an untouched table.
    name: 'a wide column and a narrow one',
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

describe('piles find the same duplicates as one heap', () => {
  for (const c of CASES) {
    it(`${c.name}: same count, however many piles`, () => {
      const one = countDuplicates(tuples(c.columns, c.count));
      expect(one).toBeGreaterThan(0); // there is something to find

      for (const buckets of [2, 4, 8, 16, 64]) {
        expect(countDuplicates(tuples(c.columns, c.count), { buckets })).toBe(one);
      }
    });

    it(`${c.name}: same finished table, however many piles`, () => {
      const ids = c.columns.map((col) => col.id);
      const label = `"${ids.join(' × ')}"`;
      const single = rowsOf(repairExactUniq(c.columns, c.count, label), ids, c.count);
      expect(new Set(single).size).toBe(c.count); // the repair did its job

      for (const buckets of [2, 8, 32]) {
        const piled = rowsOf(repairExactUniq(c.columns, c.count, label, { buckets }), ids, c.count);
        expect(piled).toEqual(single);
      }
    });
  }

  it('a duplicate pair never lands in two piles', () => {
    /*
     * The property the whole idea rests on. Anything else here could be fixed
     * by looking harder; this one cannot — a pair split across piles is a
     * duplicate nobody will ever see.
     */
    for (const buckets of [2, 7, 16, 100]) {
      for (let i = 0; i < 500; i++) {
        const key = `Male${JOIN}Ivan${String(i)}${JOIN}Petrov${String(i % 97)}`;
        // The same tuple built a second time, character by character, must land
        // in the same pile — the hash reads the string, not the object it came
        // from. A pair split across two piles is a duplicate nobody sees.
        const rebuilt = ['Male', `Ivan${String(i)}`, `Petrov${String(i % 97)}`].join(JOIN);
        expect(rebuilt).toBe(key);
        expect(bucketOf(rebuilt, buckets)).toBe(bucketOf(key, buckets));
      }
    }
  });

  it('a short run gets one pile, which is what the older engine does', () => {
    expect(bucketCountFor(1000, 12)).toBe(1);
    expect(bucketCountFor(999_999, 12)).toBe(1);
    expect(bucketCountFor(1_000_000, 12)).toBe(48);
    expect(bucketCountFor(50_000_000, 2)).toBe(8);
    expect(bucketCountFor(50_000_000, 200)).toBe(256); // capped
  });
});
