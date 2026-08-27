/**
 * The affine transform half of the SVG reader.
 *
 * A drawing out of any vector editor puts its shapes inside nested
 * `<g transform="…">` groups, so a point on the page is the point in the path
 * data mapped through an accumulated matrix. Get the composition order or one
 * sign wrong and the drawing still LOADS — it just comes out mirrored, sheared
 * or somewhere off the canvas, which no test of "did it parse" would notice.
 *
 * The expectations here are worked out from the SVG transform spec, not read
 * back off this implementation.
 */

import { describe, expect, it } from 'vitest';

import {
  apply,
  IDENTITY,
  type Matrix,
  flattenPathD,
  multiply,
  parseTransform,
  type Pt,
} from '../../src/generators/svg-path.js';

/** Matrices and points compare to a tolerance: rotation goes through cos/sin. */
const near = (got: readonly number[], want: readonly number[]): void => {
  expect(got).toHaveLength(want.length);
  got.forEach((n, i) => {
    expect(n).toBeCloseTo(want[i] ?? Number.NaN, 10);
  });
};

describe('multiply', () => {
  it('leaves a matrix alone when multiplied by the identity, either side', () => {
    const m: Matrix = [2, 3, 4, 5, 6, 7];
    near(multiply(m, IDENTITY), m);
    near(multiply(IDENTITY, m), m);
  });

  it('composes so the RIGHT matrix applies first', () => {
    // SVG reads a transform list left to right, applying the rightmost to the
    // point first. Scale-then-translate and translate-then-scale differ, and
    // this is the pair that tells them apart.
    const translate: Matrix = [1, 0, 0, 1, 10, 0];
    const scale: Matrix = [2, 0, 0, 2, 0, 0];
    near(apply(multiply(translate, scale), [1, 0]), [12, 0]); // scale, then move
    near(apply(multiply(scale, translate), [1, 0]), [22, 0]); // move, then scale
  });
});

describe('apply', () => {
  it('maps a point through translation, scale and their combination', () => {
    near(apply(IDENTITY, [3, 4]), [3, 4]);
    near(apply([1, 0, 0, 1, 5, -2], [3, 4]), [8, 2]);
    near(apply([2, 0, 0, 3, 0, 0], [3, 4]), [6, 12]);
  });
});

describe('parseTransform', () => {
  it('is the identity for an attribute with nothing in it', () => {
    near(parseTransform(''), IDENTITY);
    near(parseTransform('   '), IDENTITY);
  });

  it('reads translate, with the second argument defaulting to zero', () => {
    near(apply(parseTransform('translate(10 20)'), [0, 0]), [10, 20]);
    near(apply(parseTransform('translate(10)'), [0, 0]), [10, 0]);
  });

  it('reads scale, where one argument means BOTH axes', () => {
    // `scale(3)` is uniform. Read as "x only" it flattens the drawing.
    near(apply(parseTransform('scale(3)'), [1, 1]), [3, 3]);
    near(apply(parseTransform('scale(2 5)'), [1, 1]), [2, 5]);
  });

  it('reads rotate in DEGREES, turning the y axis down as SVG does', () => {
    // 90° takes (1,0) to (0,1) — down the screen, because SVG's y grows down.
    near(apply(parseTransform('rotate(90)'), [1, 0]), [0, 1]);
    near(apply(parseTransform('rotate(180)'), [1, 0]), [-1, 0]);
  });

  it('rotates about a given centre, which stays where it is', () => {
    const m = parseTransform('rotate(90 4 4)');
    near(apply(m, [4, 4]), [4, 4]);
    near(apply(m, [5, 4]), [4, 5]);
  });

  it('reads skewX and skewY, which shear one axis along the other', () => {
    near(apply(parseTransform('skewX(45)'), [0, 1]), [1, 1]);
    near(apply(parseTransform('skewY(45)'), [1, 0]), [1, 1]);
  });

  it('reads a raw matrix in SVG argument order', () => {
    near(parseTransform('matrix(1 2 3 4 5 6)'), [1, 2, 3, 4, 5, 6]);
  });

  it('accepts commas, extra spaces and a chain of primitives', () => {
    // Editors write the separator differently from one another, and a chain
    // has to compose left to right — the rightmost reaching the point first.
    const spaced = parseTransform('translate(10, 20)  scale(2)');
    const tight = parseTransform('translate(10,20)scale(2)');
    near(spaced, tight);
    near(apply(spaced, [1, 1]), [12, 22]);
  });

  it('ignores a primitive it does not know rather than dropping the chain', () => {
    // An unknown name means the identity, so the transforms around it survive.
    near(apply(parseTransform('translate(5 5) nonsense(9) translate(1 1)'), [0, 0]), [6, 6]);
  });

  it('ignores text that is not a transform at all', () => {
    near(parseTransform('url(#gradient)'), IDENTITY);
  });
});

describe('the composition a nested <g> produces', () => {
  it('puts a point where the editor drew it', () => {
    // Two nested groups: the outer moves the drawing, the inner scales it.
    // The point is scaled first, then moved — the order a reader has to keep.
    const outer = parseTransform('translate(100 50)');
    const inner = parseTransform('scale(2)');
    const p: Pt = [3, 4];
    near(apply(multiply(outer, inner), p), [106, 58]);
  });
});

describe('flattenPathD', () => {
  // Flattening has to be DETERMINISTIC: the subdivision count is derived from
  // the control polygon rather than from a tolerance, so every implementation
  // splits a given curve into the same number of points. A drawing that came
  // out with 40 points here and 41 in Rust would put a different value on
  // every row of a generated column.

  it('walks straight segments, absolute and relative alike', () => {
    expect(flattenPathD('M 0 0 L 10 0 L 10 10')).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    // Lowercase is relative — the same shape, written as offsets.
    expect(flattenPathD('m 0 0 l 10 0 l 0 10')).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
  });

  it('reads H and V as the one-axis moves they are', () => {
    expect(flattenPathD('M 5 5 H 15 V 25')).toEqual([
      [5, 5],
      [15, 5],
      [15, 25],
    ]);
  });

  it('closes a path back to where the subpath started', () => {
    const pts = flattenPathD('M 0 0 L 10 0 L 10 10 Z');
    expect(pts.at(-1)).toEqual([0, 0]);
  });

  it('flattens a cubic into points that start and end ON the curve', () => {
    const pts = flattenPathD('M 0 0 C 0 10 10 10 10 0');
    expect(pts[0]).toEqual([0, 0]);
    expect(pts.at(-1)?.[0]).toBeCloseTo(10, 9);
    expect(pts.at(-1)?.[1]).toBeCloseTo(0, 9);
    // A Bezier stays inside the box of its control points, so a flattening
    // that overshoots — the usual sign of a wrong basis term — shows here.
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(-1e-9);
      expect(x).toBeLessThanOrEqual(10 + 1e-9);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeLessThanOrEqual(10 + 1e-9);
    }
  });

  it('flattens a quadratic the same way a cubic with lifted controls would', () => {
    // A quadratic IS a cubic with its control points raised by 2/3, and the
    // reader converts rather than implementing a second basis. The two spellings
    // therefore have to agree point for point.
    const quad = flattenPathD('M 0 0 Q 5 10 10 0');
    const asCubic = flattenPathD(
      `M 0 0 C ${String((2 / 3) * 5)} ${String((2 / 3) * 10)} ` +
        `${String(10 - (2 / 3) * 5)} ${String((2 / 3) * 10)} 10 0`,
    );
    expect(quad).toHaveLength(asCubic.length);
    quad.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(asCubic[i]?.[0] ?? Number.NaN, 9);
      expect(y).toBeCloseTo(asCubic[i]?.[1] ?? Number.NaN, 9);
    });
  });

  it('splits a longer curve into more points, and caps how many', () => {
    // The count follows the control polygon's length, between 4 and 64.
    const short = flattenPathD('M 0 0 C 0 1 1 1 1 0');
    const long = flattenPathD('M 0 0 C 0 300 300 300 300 0');
    expect(short.length).toBeGreaterThanOrEqual(5); // the move, plus at least 4
    expect(long.length).toBeGreaterThan(short.length);
    expect(long.length).toBeLessThanOrEqual(65);
  });

  it('flattens an arc, landing on the endpoint it was given', () => {
    const pts = flattenPathD('M 0 0 A 10 10 0 0 1 20 0');
    expect(pts[0]).toEqual([0, 0]);
    expect(pts.at(-1)?.[0]).toBeCloseTo(20, 6);
    expect(pts.at(-1)?.[1]).toBeCloseTo(0, 6);
  });

  it('gives the same points for the same input, every time', () => {
    const d = 'M 0 0 C 0 10 10 10 10 0 Q 15 -5 20 0 A 5 5 0 0 1 30 0';
    expect(flattenPathD(d)).toEqual(flattenPathD(d));
  });

  it('returns nothing for an empty or meaningless path', () => {
    expect(flattenPathD('')).toEqual([]);
    expect(flattenPathD('   ')).toEqual([]);
  });
});
