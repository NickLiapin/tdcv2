/**
 * How far TdcMath may sit from the true value.
 *
 * Bit-identity across the five implementations is pinned by a shared fixture.
 * This is the other half: that the shared answer is also a GOOD answer. Nothing
 * in the parity fixture would notice five implementations agreeing on a number
 * that is wrong in its fourth digit.
 *
 * The reference is Node's libm — not because it is authoritative (the whole
 * reason TdcMath exists is that the libms disagree) but because it is within an
 * ulp or two of correct, so a large gap means TdcMath is wrong, not that the
 * two chose different last bits.
 *
 * ── Why 4 and not 2 ──────────────────────────────────────────────────────────
 * The measured worst is 3 (asin, acos); everything else is 1 or 2. The ceiling
 * is 4 so a different libm on a different machine cannot turn this red on its
 * own. It is still a real check: when `cos` truncated its series two terms
 * early, this bound was exceeded threefold, and `sin` and `tan` with it.
 *
 * ── Why the grids reach the ends ─────────────────────────────────────────────
 * That bug lived at |r| = π/4, the edge of the reduced interval, and was
 * invisible on a sample of convenient arguments. Every grid below runs to its
 * boundary on purpose.
 */

import { describe, expect, it } from 'vitest';

import * as TdcMath from '../../src/math/tdc-math.js';

const view = new DataView(new ArrayBuffer(8));

/** A double's bits as a sign-magnitude ordering, so subtraction counts steps. */
function ordinal(x: number): bigint {
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const sign = 1n << 63n;
  return bits & sign ? sign - (bits & ~sign) : bits;
}

/** How many representable doubles lie between two values. */
function ulpsApart(a: number, b: number): number {
  if (a === b) return 0;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  const d = ordinal(a) - ordinal(b);
  return Number(d < 0n ? -d : d);
}

function grid(lo: number, hi: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => lo + ((hi - lo) * i) / (count - 1));
}

/**
 * Points spread evenly by RATIO rather than by distance.
 *
 * `expm1`, `log1p`, `asinh` and `atanh` all exist for arguments near zero,
 * where a linear grid puts almost no points: from 10⁻¹⁸ to 0.5 it would place
 * everything at the far end and never test what the function is for.
 */
function byRatio(lo: number, hi: number, count: number): number[] {
  const steps = Array.from({ length: count }, (_, i) =>
    Math.exp(Math.log(lo) + ((Math.log(hi) - Math.log(lo)) * i) / (count - 1)),
  );
  return [...steps, ...steps.map((v) => -v)];
}

const CEILING = 4;

interface Case {
  readonly name: string;
  readonly mine: (x: number) => number;
  readonly host: (x: number) => number;
  readonly points: readonly number[];
}

const CASES: readonly Case[] = [
  { name: 'sqrt', mine: TdcMath.sqrt, host: Math.sqrt, points: grid(0, 1e9, 2001) },
  {
    name: 'exp',
    mine: TdcMath.exp,
    host: Math.exp,
    points: [...grid(-700, 700, 2001), ...grid(-2, 2, 501)],
  },
  {
    name: 'log',
    mine: TdcMath.log,
    host: Math.log,
    points: [...grid(1e-9, 1e9, 2001), ...grid(0.5, 2, 501)],
  },
  { name: 'log10', mine: TdcMath.log10, host: Math.log10, points: grid(1e-9, 1e9, 2001) },
  {
    name: 'sin',
    mine: TdcMath.sin,
    host: Math.sin,
    points: [...grid(-100, 100, 2001), ...grid(-1, 1, 501)],
  },
  {
    name: 'cos',
    mine: TdcMath.cos,
    host: Math.cos,
    points: [...grid(-100, 100, 2001), ...grid(-1, 1, 501)],
  },
  { name: 'tan', mine: TdcMath.tan, host: Math.tan, points: grid(-10, 10, 2001) },
  {
    name: 'atan',
    mine: TdcMath.atan,
    host: Math.atan,
    points: [...grid(-50, 50, 2001), ...grid(-1, 1, 501)],
  },
  { name: 'asin', mine: TdcMath.asin, host: Math.asin, points: grid(-1, 1, 2001) },
  { name: 'acos', mine: TdcMath.acos, host: Math.acos, points: grid(-1, 1, 2001) },
  {
    name: 'sinh',
    mine: TdcMath.sinh,
    host: Math.sinh,
    points: [...grid(-30, 30, 2001), ...grid(-1, 1, 501)],
  },
  {
    name: 'cosh',
    mine: TdcMath.cosh,
    host: Math.cosh,
    points: [...grid(-30, 30, 2001), ...grid(-1, 1, 501)],
  },
  {
    name: 'tanh',
    mine: TdcMath.tanh,
    host: Math.tanh,
    points: [...grid(-25, 25, 2001), ...grid(-1, 1, 501)],
  },
  {
    name: 'cbrt',
    mine: TdcMath.cbrt,
    host: Math.cbrt,
    points: [...grid(-1000, 1000, 2001), ...grid(-1, 1, 501)],
  },
  {
    name: 'expm1',
    mine: TdcMath.expm1,
    host: Math.expm1,
    points: [...grid(-40, 40, 1001), ...byRatio(1e-18, 0.5, 501)],
  },
  {
    name: 'log1p',
    mine: TdcMath.log1p,
    host: Math.log1p,
    points: [...grid(-0.99, 100, 1001), ...byRatio(1e-18, 0.9, 501)],
  },
  { name: 'log2', mine: TdcMath.log2, host: Math.log2, points: grid(1e-9, 1e9, 2001) },
  {
    name: 'asinh',
    mine: TdcMath.asinh,
    host: Math.asinh,
    points: [...grid(-100, 100, 1001), ...byRatio(1e-18, 1, 501)],
  },
  {
    name: 'acosh',
    mine: TdcMath.acosh,
    host: Math.acosh,
    points: [...grid(1, 1000, 1001), ...grid(1, 1.001, 501)],
  },
  {
    name: 'atanh',
    mine: TdcMath.atanh,
    host: Math.atanh,
    points: [...grid(-0.999999, 0.999999, 1001), ...byRatio(1e-18, 0.5, 501)],
  },
];

describe('TdcMath lands where the true value is', () => {
  it.each(CASES.map((c) => [c.name, c] as const))(
    `%s stays within ${String(CEILING)} ulp of libm`,
    (_name, c) => {
      let worst = 0;
      let at = 0;
      for (const x of c.points) {
        const d = ulpsApart(c.mine(x), c.host(x));
        if (d > worst) {
          worst = d;
          at = x;
        }
      }
      expect(worst, `worst at x = ${String(at)}`).toBeLessThanOrEqual(CEILING);
    },
  );

  /**
   * `pow` is measured differently from the rest, because two separate
   * mechanisms widen it and neither is a defect:
   *
   *   a WHOLE exponent goes through repeated squaring, and squaring doubles
   *   whatever relative error it was handed; after k squarings the drift is
   *   roughly 2^k — that is, proportional to y itself, so `x^412` is far looser
   *   than `x^3` even though both take the "exact" path
   *
   *   any OTHER exponent goes through exp(y·log x), and `exp` turns an ABSOLUTE
   *   error in its argument into a RELATIVE error in its answer; `log x` is good
   *   to about 2 ulp, so the drift scales with |y·log x|
   *
   * Tightening either needs arithmetic carried in two doubles, written five
   * times over. What is asserted instead is the thing a config actually depends
   * on: twelve correct significant digits, everywhere.
   */
  it('pow keeps twelve significant digits over the whole grid', () => {
    let worst = 0;
    let at = '';
    for (const x of grid(0.01, 100, 301)) {
      for (const y of grid(-1024, 1024, 401)) {
        const host = Math.pow(x, y);
        // A subnormal result is excluded because it has fewer than twelve
        // significant digits to keep: down there the claim is about the double,
        // not about `pow`.
        if (!Number.isFinite(host) || Math.abs(host) < 2.3e-308) continue;
        const relative = Math.abs((TdcMath.pow(x, y) - host) / host);
        if (relative > worst) {
          worst = relative;
          at = `${String(x)}^${String(y)}`;
        }
      }
    }
    expect(worst, `worst at ${at}`).toBeLessThan(1e-12);
  });

  /**
   * The exponents people write by hand, held to a wider but still tight bound.
   *
   * The bound grows WITH the exponent rather than being a constant, because
   * that is the mechanism — the ordinary ceiling, plus what the doubling adds:
   * `x²` inherits twice the relative error of x, so k squarings multiply it by
   * 2^k ≈ y. Measured 4 ulp around y = 3, 5 by y = 10, 22 by y = 20 — tracking
   * the exponent, exactly as the doubling predicts. The bound allows twice that
   * slope, so it is the SHAPE being asserted, not today's numbers: a constant
   * picked to make these pass would go on passing through a real regression.
   */
  it('pow drifts with the exponent, and no faster', () => {
    for (const x of grid(0.5, 100, 401)) {
      for (const y of [-20, -10, -3, -2.5, -2, -1.5, -1, -0.5, 0.5, 1, 1.5, 2, 2.5, 3, 10, 20]) {
        expect(
          ulpsApart(TdcMath.pow(x, y), Math.pow(x, y)),
          `pow(${String(x)}, ${String(y)})`,
        ).toBeLessThanOrEqual(CEILING + 2 * Math.abs(y));
      }
    }
    expect(TdcMath.pow(100, 0.5)).toBe(10);
    expect(TdcMath.pow(9, 1.5)).toBe(27);
    expect(TdcMath.pow(16, 2.5)).toBe(1024);
  });

  it('hypot stays within the ceiling, and does not overflow on the way', () => {
    let worst = 0;
    let at = '';
    for (const x of grid(-100, 100, 201)) {
      for (const y of grid(-100, 100, 201)) {
        const d = ulpsApart(TdcMath.hypot(x, y), Math.hypot(x, y));
        if (d > worst) {
          worst = d;
          at = `${String(x)}, ${String(y)}`;
        }
      }
    }
    expect(worst, `worst at ${at}`).toBeLessThanOrEqual(CEILING);
    // The reason the larger side is factored out first: squaring 1e200 alone
    // would reach infinity, and the answer here is nowhere near it.
    expect(TdcMath.hypot(1e200, 1e200)).toBe(Math.hypot(1e200, 1e200));
    expect(TdcMath.hypot(1e-200, 1e-200)).toBe(Math.hypot(1e-200, 1e-200));
    expect(TdcMath.hypot(3, 4)).toBe(5);
  });

  /**
   * `sign` has nothing to round, so it is checked for what it returns rather
   * than for how close it lands.
   */
  it('sign answers exactly', () => {
    expect(TdcMath.sign(-7.5)).toBe(-1);
    expect(TdcMath.sign(7.5)).toBe(1);
    expect(TdcMath.sign(0)).toBe(0);
    expect(TdcMath.sign(-0)).toBe(0);
    expect(TdcMath.sign(Number.NaN)).toBeNaN();
    expect(TdcMath.sign(Number.POSITIVE_INFINITY)).toBe(1);
  });

  /**
   * What the near-zero pair exist for: at these arguments the textbook forms
   * return zero, having thrown the answer away before computing it.
   */
  it('keeps the answer where the textbook form would have lost it', () => {
    expect(TdcMath.expm1(1e-20)).toBe(1e-20);
    expect(TdcMath.log1p(1e-20)).toBe(1e-20);
    expect(TdcMath.asinh(1e-20)).toBe(1e-20);
    expect(TdcMath.atanh(1e-20)).toBe(1e-20);
    // The same arguments through the definitions, for contrast.
    expect(TdcMath.exp(1e-20) - 1).toBe(0);
    expect(TdcMath.log(1 + 1e-20)).toBe(0);
    // log2 of a power of two is a whole number, which log(x)/ln2 would miss.
    expect(TdcMath.log2(8)).toBe(3);
    expect(TdcMath.log2(1024)).toBe(10);
    expect(TdcMath.log2(0.25)).toBe(-2);
    expect(TdcMath.acosh(1)).toBe(0);
  });

  it('atan2 stays within the ceiling over all four quadrants', () => {
    let worst = 0;
    let at = '';
    for (const y of grid(-20, 20, 121)) {
      for (const x of grid(-20, 20, 121)) {
        const d = ulpsApart(TdcMath.atan2(y, x), Math.atan2(y, x));
        if (d > worst) {
          worst = d;
          at = `${String(y)}, ${String(x)}`;
        }
      }
    }
    expect(worst, `worst at ${at}`).toBeLessThanOrEqual(CEILING);
  });

  /**
   * A whole-number exponent takes the repeated-squaring path, which is exact,
   * and a cube root of a perfect cube has to come out whole. Both are the
   * results a config would compare against a round number.
   */
  it('gives whole answers where whole answers exist', () => {
    expect(TdcMath.pow(10, 3)).toBe(1000);
    expect(TdcMath.pow(2, 10)).toBe(1024);
    expect(TdcMath.pow(7, -2)).toBe(1 / 49);
    expect(TdcMath.cbrt(27)).toBe(3);
    expect(TdcMath.cbrt(-8)).toBe(-2);
    expect(TdcMath.cbrt(1000)).toBe(10);
    expect(TdcMath.acos(1)).toBe(0);
    expect(TdcMath.cosh(0)).toBe(1);
    expect(TdcMath.tanh(0)).toBe(0);
    expect(TdcMath.sqrt(144)).toBe(12);
  });

  it('answers at the edges of each domain', () => {
    expect(TdcMath.asin(2)).toBeNaN();
    expect(TdcMath.acos(-1.5)).toBeNaN();
    expect(TdcMath.sqrt(-1)).toBeNaN();
    expect(TdcMath.log(-1)).toBeNaN();
    expect(TdcMath.log(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(TdcMath.asin(1)).toBe(TdcMath.PI / 2);
    expect(TdcMath.acos(-1)).toBe(TdcMath.PI);
    expect(TdcMath.atan(Number.POSITIVE_INFINITY)).toBe(TdcMath.PI / 2);
    expect(TdcMath.tanh(Number.POSITIVE_INFINITY)).toBe(1);
    expect(TdcMath.tanh(Number.NEGATIVE_INFINITY)).toBe(-1);
    expect(TdcMath.cosh(Number.NEGATIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    // sinh and cosh outlive exp: e^710 overflows, but their halved form does not.
    expect(Number.isFinite(TdcMath.cosh(710))).toBe(true);
    expect(Number.isFinite(TdcMath.sinh(-710))).toBe(true);
    expect(TdcMath.atan2(0, 0)).toBe(0);
    expect(TdcMath.atan2(1, 0)).toBe(TdcMath.PI / 2);
    expect(TdcMath.atan2(0, -1)).toBe(TdcMath.PI);
  });
});
