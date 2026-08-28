import { describe, expect, it } from 'vitest';

import { dealAcrossBlocks } from '../../src/sequence/env-groups.js';

/**
 * The block dealer, on its own.
 *
 * A `<switch>` inside a `<uniq>` cuts the rows into blocks by its subject, and each block is
 * arranged separately. The free columns are dealt across those blocks first, or one block ends up
 * holding four `a`s while the next holds none and the group runs out of distinct rows far below its
 * real ceiling.
 *
 * The deal has to promise three things, and there is one test below for each: the multiset is
 * preserved exactly, so `percent=` stays exact; every block gets precisely the number of rows it
 * has; and WHICH block each copy lands in follows largest remainder — the same rule the percentages
 * use, so five implementations cannot disagree about who gets the odd one.
 */
const SHAPES: readonly {
  readonly what: string;
  readonly column: readonly string[];
  readonly sizes: readonly number[];
  readonly want: readonly (readonly string[])[];
}[] = [
  {
    what: 'an even split needs no remainder at all',
    column: ['a', 'a', 'b', 'b'],
    sizes: [2, 2],
    want: [
      ['a', 'b'],
      ['a', 'b'],
    ],
  },
  {
    what: 'the odd copy goes to the first block on a tie',
    column: ['a', 'a', 'a', 'b'],
    sizes: [2, 2],
    want: [
      ['a', 'a'],
      ['a', 'b'],
    ],
  },
  {
    what: 'blocks of different sizes take proportional shares',
    column: ['x', 'x', 'x', 'y'],
    sizes: [1, 3],
    want: [['x'], ['x', 'x', 'y']],
  },
  {
    what: 'one block regroups the column by value, in first-seen order',
    column: ['a', 'b', 'a', 'b'],
    sizes: [4],
    want: [['a', 'a', 'b', 'b']],
  },
  {
    what: 'three blocks, three values, none of them dividing evenly',
    column: ['p', 'q', 'r', 'p', 'q', 'r', 'p', 'q', 'r', 'p', 'q', 'r'],
    sizes: [5, 4, 3],
    want: [
      ['p', 'p', 'q', 'q', 'r'],
      ['p', 'q', 'r', 'r'],
      ['p', 'q', 'r'],
    ],
  },
  { what: 'nothing to deal', column: [], sizes: [0], want: [[]] },
  {
    what: 'a block with no room takes nothing',
    column: ['z', 'z', 'z'],
    sizes: [0, 3],
    want: [[], ['z', 'z', 'z']],
  },
];

describe('the block dealer', () => {
  it.each(SHAPES)('$what', ({ column, sizes, want }) => {
    expect(dealAcrossBlocks(column, sizes)).toEqual(want);
  });

  it.each(SHAPES)('every block gets exactly the rows it has — $what', ({ column, sizes }) => {
    expect(dealAcrossBlocks(column, sizes).map((block) => block.length)).toEqual(sizes);
  });

  it.each(SHAPES)('nothing is lost and nothing is invented — $what', ({ column, sizes }) => {
    expect(dealAcrossBlocks(column, sizes).flat().sort()).toEqual([...column].sort());
  });

  it('gives a value short of a whole share somewhere to land', () => {
    // `y` is owed a quarter of a row in one block and three quarters in the other. A value that
    // rounds to nothing everywhere would be dropped, so the remainder pass hands it a whole row.
    expect(dealAcrossBlocks(['x', 'x', 'x', 'y'], [2, 2])).toEqual([
      ['x', 'x'],
      ['x', 'y'],
    ]);
  });

  it('breaks a remainder tie toward the block with the most room', () => {
    // Both values are owed half a row in each block. Ties used to go to block 0
    // every time, which starved the LAST value there — the room tie-break sends
    // `a`'s odd copy to the roomier block 1, and then `b`'s to block 0, whose
    // room is now the greater. Self-balancing: each odd copy shrinks the room
    // that attracted it. Measured on the shape this cured: whether a count near
    // the ceiling collected used to depend on the seed; now every seed reaches
    // the true ceiling.
    expect(dealAcrossBlocks(['a', 'a', 'b', 'b'], [1, 3])).toEqual([['b'], ['a', 'a', 'b']]);
  });
});
