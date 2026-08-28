/**
 * A `<uniq>` group with a `<switch>` in it: the deal ACROSS the blocks.
 *
 * A switch cuts the group's rows into blocks — male rows here, female rows
 * there — because a switched value answers the subject of its own row and
 * cannot move to a row with a different one. Everything else in the group is
 * free to move anywhere, and until the deal existed it did not: each block
 * arranged whatever values happened to fall into it.
 *
 * That was expensive. A `text` list is laid out in exact shares over the WHOLE
 * column; the cut then hands one block `[7,3,4]` where an even share is
 * `[5,5,4]`, and the difference is real — 13 achievable tuples against 14, on
 * data holding 18 combinations. Measured across eleven shapes, the ceiling rose
 * by half again: 7 rows to 12, 11 to 18, 24 to 30.
 *
 * Two things have to hold at once, and the second is the one that bites: the
 * group must reach further than it did, AND no value may cross a block. A deal
 * that moves the switched column — or the SUBJECT the blocks were cut by — buys
 * distinct rows by putting a male name on a female row, which is the failure
 * this whole area exists to prevent. It happened, on the first attempt, and it
 * is why the invariant is asserted before any number is.
 */

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/index.js';

interface Shape {
  readonly name: string;
  /** The subject's values, in order. */
  readonly subjects: readonly string[];
  /** `percent=` on the subject — one share short, as the language allows. */
  readonly percent: string;
  /** The switched member's values, per subject. Disjoint on purpose. */
  readonly perSubject: readonly (readonly string[])[];
  /** A member free to move between blocks. */
  readonly free: readonly string[];
  /** A switched `<mix>`: the first value is that subject's own, the rest shared. */
  readonly mix?: readonly (readonly string[])[];
  readonly mixPercent?: string;
  /** The highest count this shape can reach — the data's true ceiling. */
  readonly ceiling: number;
}

const SHAPES: readonly Shape[] = [
  {
    name: 'two subjects',
    subjects: ['M', 'F'],
    percent: '50,50',
    perSubject: [
      ['m1', 'm2'],
      ['f1', 'f2'],
    ],
    free: ['a', 'b', 'c'],
    ceiling: 12,
  },
  {
    name: 'three subjects',
    subjects: ['X', 'Y', 'Z'],
    percent: '34,33',
    perSubject: [
      ['x1', 'x2'],
      ['y1', 'y2'],
      ['z1', 'z2'],
    ],
    free: ['a', 'b', 'c'],
    ceiling: 18,
  },
  {
    name: 'four subjects',
    subjects: ['A', 'B', 'C', 'D'],
    percent: '25,25,25',
    perSubject: [
      ['a1', 'a2'],
      ['b1', 'b2'],
      ['c1', 'c2'],
      ['d1', 'd2'],
    ],
    free: ['p', 'q', 'r', 's'],
    ceiling: 32,
  },
  {
    name: 'a long free list',
    subjects: ['M', 'F'],
    percent: '50,50',
    perSubject: [
      ['m1', 'm2', 'm3'],
      ['f1', 'f2', 'f3'],
    ],
    free: ['a', 'b', 'c', 'd', 'e'],
    ceiling: 30,
  },
  {
    name: 'one free value only',
    subjects: ['M', 'F'],
    percent: '50,50',
    perSubject: [
      ['m1', 'm2', 'm3', 'm4'],
      ['f1', 'f2', 'f3', 'f4'],
    ],
    free: ['only'],
    ceiling: 8,
  },
  {
    name: 'one name per subject',
    subjects: ['M', 'F'],
    percent: '50,50',
    perSubject: [['m1'], ['f1']],
    free: ['a', 'b', 'c', 'd', 'e', 'f'],
    ceiling: 12,
  },
  {
    name: 'a switched mix, 20/80',
    subjects: ['M', 'F'],
    percent: '50,50',
    perSubject: [
      ['m1', 'm2'],
      ['f1', 'f2'],
    ],
    free: ['a', 'b', 'c'],
    mix: [
      ['dm', 'g1', 'g2'],
      ['df', 'g1', 'g2'],
    ],
    mixPercent: '20,80',
    ceiling: 30,
  },
  {
    name: 'a switched mix, even',
    subjects: ['M', 'F'],
    percent: '50,50',
    perSubject: [
      ['m1', 'm2'],
      ['f1', 'f2'],
    ],
    free: ['a', 'b'],
    mix: [
      ['dm', 'g1'],
      ['df', 'g1'],
    ],
    mixPercent: '50,50',
    ceiling: 16,
  },
];

const config = (shape: Shape, count: number, seed = 's1'): string => {
  const branches = shape.subjects
    .map(
      (value, i) =>
        `<case is="${value}"><gen type="text" value="${shape.perSubject[i]?.join(',') ?? ''}"/></case>`,
    )
    .join('');
  const mix = shape.mix
    ? `<switch name="D" on="G">${shape.subjects
        .map(
          (value, i) =>
            `<case is="${value}"><mix percent="${shape.mixPercent ?? '50'}">` +
            `<case><gen type="text" value="${shape.mix?.[i]?.[0] ?? 'x'}"/></case>` +
            `<case><gen type="text" value="${shape.mix?.[i]?.slice(1).join(',') ?? 'y'}"/></case>` +
            '</mix></case>',
        )
        .join('')}</switch>`
    : '';
  const columns = ['G', 'F', 'L', ...(shape.mix ? ['D'] : [])];
  return (
    `<tdc><env count="${String(count)}" seed="${seed}" local="en"><uniq>` +
    `<sequence name="G"><gen type="text" value="${shape.subjects.join(',')}" percent="${shape.percent}"/></sequence>` +
    `<switch name="F" on="G">${branches}</switch>` +
    `<sequence name="L"><gen type="text" value="${shape.free.join(',')}"/></sequence>` +
    mix +
    `</uniq></env><block><line><data>${columns.map((c) => `\${{${c}}}`).join('|')}</data></line></block></tdc>`
  );
};

const rowsOf = (shape: Shape, count: number, seed = 's1'): string[][] =>
  new TDC({ configString: config(shape, count, seed) })
    .toString()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('|'));

describe.each(SHAPES)('a uniq group cut into blocks — $name', (shape) => {
  const counts = [2, 3, Math.max(2, shape.ceiling >> 1), shape.ceiling - 1, shape.ceiling];

  it('never puts a value on a row whose subject it does not answer', () => {
    // The invariant, asserted first because it is the one worth having. A deal
    // that moved the switched column, or the subject the blocks were cut by,
    // produced eighteen rows of thirty-six carrying the other gender's name —
    // every one of them counted as a distinct row.
    for (const count of counts) {
      for (const [subject, switched, , mixed] of rowsOf(shape, count)) {
        const i = shape.subjects.indexOf(subject ?? '');
        expect(i, `unknown subject ${String(subject)}`).toBeGreaterThanOrEqual(0);
        expect(
          shape.perSubject[i],
          `${String(subject)} carried ${String(switched)} at count=${String(count)}`,
        ).toContain(switched);
        if (shape.mix) {
          expect(
            shape.mix[i],
            `${String(subject)} carried ${String(mixed)} at count=${String(count)}`,
          ).toContain(mixed);
        }
      }
    }
  });

  it('makes every row distinct', () => {
    for (const count of counts) {
      const rows = rowsOf(shape, count).map((cells) => cells.join('|'));
      expect(rows, `count=${String(count)}`).toHaveLength(count);
      expect(new Set(rows).size, `count=${String(count)}`).toBe(count);
    }
  });

  it('reaches the ceiling the data really holds', () => {
    expect(rowsOf(shape, shape.ceiling)).toHaveLength(shape.ceiling);
  });

  it('refuses past the ceiling rather than repeating a row', () => {
    expect(() => rowsOf(shape, shape.ceiling + 1)).toThrow(/cannot produce/);
  });

  /*
   * The refusal used to report ONE BLOCK's ceiling against the WHOLE RUN's
   * count, which on a two-subject group reads as half the truth — a shape that
   * renders 23 rows was refused at 24 saying "at most 11". A number below what
   * the config demonstrably reaches sends the reader off to widen data that was
   * never the problem, so the contract is: never understate, and stay under
   * what was asked for (or the refusal contradicts itself).
   */
  it('reports a reach at least as large as the shape truly has', () => {
    let message = '';
    try {
      rowsOf(shape, shape.ceiling + 1);
    } catch (error) {
      message = (error as Error).message;
    }
    const found = /at most (\d+) distinct/.exec(message);
    expect(found, message).not.toBeNull();
    const reported = Number(found?.[1] ?? 0);
    expect(reported).toBeGreaterThanOrEqual(shape.ceiling);
    expect(reported).toBeLessThan(shape.ceiling + 1);
  });

  it('gives the same bytes for the same seed, and different for another', () => {
    const half = Math.max(2, shape.ceiling >> 1);
    expect(rowsOf(shape, half)).toEqual(rowsOf(shape, half));
    // Not a promise that seeds differ — a small enough group can exhaust its
    // combinations — only that changing one is allowed to change the output.
    expect(rowsOf(shape, half, 's2')).toHaveLength(half);
  });
});

describe('what the deal bought, counted', () => {
  /*
   * Which counts a shape can reach is RAGGED at the top, and was before the
   * deal too. Each count draws its own multiset, so one lands well and the next
   * does not: on the shape below, 27, 29 and 30 render while 25, 26 and 28 are
   * refused. That is a property of arranging what was drawn rather than
   * redrawing to fit, and it is why these are measured counts and not a rule.
   *
   * What the deal moved, on that shape:
   *
   *   before   2–18 render, 19 and 20 refused, 21–24 render, nothing above
   *   after    2–24 render with no gap, and 27, 29, 30 as well
   *
   * so the unbroken run went from 18 to 24 and the ceiling from 24 to 30.
   */
  const longFree = SHAPES.find((s) => s.name === 'a long free list')!;

  it.each([19, 20, 27, 29, 30])('renders %i, which used to be refused', (count) => {
    const rows = rowsOf(longFree, count);
    expect(rows).toHaveLength(count);
    expect(new Set(rows.map((r) => r.join('|'))).size).toBe(count);
  });

  it('renders every count up to 24 without a gap', () => {
    for (let count = 2; count <= 24; count++) {
      expect(rowsOf(longFree, count), `count=${String(count)}`).toHaveLength(count);
    }
  });
});

describe('the seed decides order, never fate', () => {
  /*
   * Before the deal's tie-break went by room, WHETHER a count near the ceiling
   * collected depended on the seed: measured on the shape below at count 24,
   * four seeds of eight collected and four refused. Same config, same data, a
   * coin flip. The multiset a block receives no longer depends on where the
   * ties happened to fall, so every seed reaches the same ceiling — the seed
   * still picks WHICH arrangement, never whether one exists.
   */
  const shape = SHAPES[0]!;

  const seeds = ['blocks', 's1', 's2', 's3', 's4', 's5', 's6', 's7'];

  it('every seed reaches the ceiling', () => {
    for (const seed of seeds) {
      expect(rowsOf(shape, shape.ceiling, seed), seed).toHaveLength(shape.ceiling);
    }
  });

  it('every seed refuses past it', () => {
    for (const seed of seeds) {
      expect(() => rowsOf(shape, shape.ceiling + 1, seed), seed).toThrow(/cannot produce/);
    }
  });
});

describe('what the deal must not disturb', () => {
  it('keeps the subject share exact', () => {
    const shape = SHAPES[0]!;
    const rows = rowsOf(shape, 12);
    expect(rows.filter(([g]) => g === 'M')).toHaveLength(6);
    expect(rows.filter(([g]) => g === 'F')).toHaveLength(6);
  });

  it('keeps a mix share exact inside its block', () => {
    const shape = SHAPES.find((s) => s.name === 'a switched mix, 20/80')!;
    const male = rowsOf(shape, 30).filter(([g]) => g === 'M');
    expect(male).toHaveLength(15);
    expect(male.filter(([, , , d]) => d === 'dm')).toHaveLength(3); // 20% of 15
    expect(male.filter(([, , , d]) => d !== 'dm')).toHaveLength(12);
  });

  it('leaves a group with no switch exactly as it was', () => {
    // One block means nothing was cut, so there is nothing to deal — and
    // dealing anyway is NOT a no-op: it rebuilds the column grouped by value,
    // which is a different order for the arrangement to work from. Two shared
    // cases moved on exactly that, both of them groups with no switch at all.
    const plain =
      '<tdc><env count="12" seed="s" local="en"><uniq>' +
      '<sequence name="A"><gen type="text" value="a,b,c"/></sequence>' +
      '<sequence name="B"><gen type="text" value="1,2,3,4"/></sequence>' +
      '</uniq></env><block><line><data>${{A}}${{B}}</data></line></block></tdc>';
    const out = new TDC({ configString: plain }).toString().split('\n').filter(Boolean);
    // Taken from the build BEFORE the deal existed, so this asserts the absence
    // of a change rather than the presence of one.
    // prettier-ignore
    expect(out).toEqual([
      'c1', 'b1', 'a1', 'c4', 'b4', 'a4', 'b2', 'a2', 'c2', 'b3', 'a3', 'c3',
    ]);
  });
});
