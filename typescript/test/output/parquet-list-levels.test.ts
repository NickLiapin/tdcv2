/**
 * The Dremel core, checked against HAND-COMPUTED levels.
 *
 * These numbers are worked out from the schema tree, not captured from our own
 * output — a snapshot of wrong levels is not a test, it is a wrong answer
 * written down twice. Getting these streams wrong yields a file every reader
 * accepts and then re-assembles into the wrong shape, so this is the one place
 * that must not be verified circularly.
 * Spec: docs/specs/2026-07-19-repeated-values-lists-and-mix-ground-truth.md §5.
 */

import { describe, expect, it } from 'vitest';

import { buildListLevels, levelBitWidth, listMaxDef } from '../../src/output/parquet/list.js';

describe('listMaxDef / levelBitWidth', () => {
  it('a required element needs one level, an optional one needs two', () => {
    // required group (LIST) +0 → repeated group +1 → required element +0
    expect(listMaxDef(false)).toBe(1);
    // ...with an optional element the leaf adds one more
    expect(listMaxDef(true)).toBe(2);
  });

  it('sizes the bit width to the maximum level', () => {
    expect(levelBitWidth(0)).toBe(0); // nothing to encode
    expect(levelBitWidth(1)).toBe(1); // 0..1
    expect(levelBitWidth(2)).toBe(2); // 0..2 needs two bits
    expect(levelBitWidth(3)).toBe(2);
    expect(levelBitWidth(4)).toBe(3);
  });
});

describe('buildListLevels — required element (max def 1)', () => {
  it('numbers a plain two-element row', () => {
    const out = buildListLevels([['10', '20']], false);
    expect(out.present).toEqual(['10', '20']);
    expect(out.repLevels).toEqual([0, 1]); // new row, then a continuation
    expect(out.defLevels).toEqual([1, 1]); // both values are there
  });

  it('gives an empty list one slot at def 0', () => {
    const out = buildListLevels([[]], false);
    expect(out.present).toEqual([]);
    expect(out.repLevels).toEqual([0]);
    expect(out.defLevels).toEqual([0]);
  });

  it('numbers a batch mixing every shape', () => {
    const out = buildListLevels([['10', '20'], [], ['30'], ['40', '50', '60']], false);
    expect(out.present).toEqual(['10', '20', '30', '40', '50', '60']);
    //                    row0        row1  row2   row3
    expect(out.repLevels).toEqual([0, 1, /**/ 0, /**/ 0, /**/ 0, 1, 1]);
    expect(out.defLevels).toEqual([1, 1, /**/ 0, /**/ 1, /**/ 1, 1, 1]);
    // One level slot per element, plus one for the empty row.
    expect(out.repLevels).toHaveLength(7);
    expect(out.defLevels).toHaveLength(out.repLevels.length);
  });

  it('every row starts with rep 0 and only continuations use rep 1', () => {
    const out = buildListLevels([['a'], ['b', 'c'], [], ['d']], false);
    expect(out.repLevels.filter((r) => r === 0)).toHaveLength(4); // one per row
    expect(out.maxRep).toBe(1);
  });

  it('leaves an empty string alone when the element is not nullable', () => {
    // Not our NULL marker here — conversion decides whether the type accepts it.
    const out = buildListLevels([['', 'x']], false);
    expect(out.present).toEqual(['', 'x']);
    expect(out.defLevels).toEqual([1, 1]);
  });
});

describe('buildListLevels — optional element (max def 2)', () => {
  it('distinguishes a present value, an absent one, and an empty list', () => {
    const out = buildListLevels([['10', ''], [], ['20']], true);
    expect(out.present).toEqual(['10', '20']); // the NULL contributes no value
    expect(out.repLevels).toEqual([0, 1, /**/ 0, /**/ 0]);
    //                             ^   ^        ^        ^
    //                     value  null      empty    value
    expect(out.defLevels).toEqual([2, 1, /**/ 0, /**/ 2]);
    expect(out.maxDef).toBe(2);
  });

  it('a row of nothing but NULLs still holds its slots', () => {
    const out = buildListLevels([['', '', '']], true);
    expect(out.present).toEqual([]);
    expect(out.repLevels).toEqual([0, 1, 1]);
    expect(out.defLevels).toEqual([1, 1, 1]);
  });
});

describe('buildListLevels — invariants that must hold for any input', () => {
  const cases: readonly (readonly string[])[][] = [
    [],
    [[]],
    [['a']],
    [['a', 'b'], [], ['c'], ['', 'd'], []],
    [[], [], []],
  ];

  for (const nullable of [false, true]) {
    it(`streams stay the same length and rows stay countable (nullable=${String(nullable)})`, () => {
      for (const rows of cases) {
        const out = buildListLevels(rows, nullable);
        expect(out.repLevels).toHaveLength(out.defLevels.length);
        // Exactly one rep-0 per row — that is how a reader counts rows back.
        expect(out.repLevels.filter((r) => r === 0)).toHaveLength(rows.length);
        // Present values never exceed the slots, and never exceed the elements.
        expect(out.present.length).toBeLessThanOrEqual(out.defLevels.length);
        expect(out.defLevels.every((d) => d >= 0 && d <= out.maxDef)).toBe(true);
        expect(out.repLevels.every((r) => r >= 0 && r <= out.maxRep)).toBe(true);
      }
    });
  }
});
