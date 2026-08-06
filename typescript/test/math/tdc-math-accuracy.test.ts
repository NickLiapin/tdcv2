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

/**
 * ── The statistical four ──────────────────────────────────────────────────────
 *
 * `erf`, `erfc`, `gamma` and `lgamma` have no counterpart in JavaScript's Math,
 * so there is nothing on this side to compare against. The tables below were
 * produced by Python's libm — the same reference the other functions are
 * measured against, just written down rather than called.
 *
 * Regenerate with:
 *   python3 -c "import math; print(math.erf(0.5))"   (and so on)
 */
const ERF_REFERENCE: readonly (readonly [number, number])[] = [
  [-3, -0.9999779095030015],
  [-2.75, -0.9998993780778804],
  [-2.5, -0.999593047982555],
  [-2.25, -0.9985372834133188],
  [-2, -0.9953222650189527],
  [-1.75, -0.9866716712191824],
  [-1.5, -0.9661051464753108],
  [-1.25, -0.9229001282564582],
  [-1, -0.8427007929497148],
  [-0.75, -0.7111556336535152],
  [-0.5, -0.5204998778130465],
  [-0.25, -0.2763263901682369],
  [0, 0],
  [0.25, 0.2763263901682369],
  [0.5, 0.5204998778130465],
  [0.75, 0.7111556336535152],
  [1, 0.8427007929497148],
  [1.25, 0.9229001282564582],
  [1.5, 0.9661051464753108],
  [1.75, 0.9866716712191824],
  [2, 0.9953222650189527],
  [2.25, 0.9985372834133188],
  [2.5, 0.999593047982555],
  [2.75, 0.9998993780778804],
  [3, 0.9999779095030015],
  [0, 0],
  [1e-8, 1.1283791670955126e-8],
  [0.5, 0.5204998778130465],
  [1, 0.8427007929497148],
  [1.5, 0.9661051464753108],
  [2, 0.9953222650189527],
  [5, 0.9999999999984626],
];
const ERFC_REFERENCE: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 0.15729920705028516],
  [2, 0.0046777349810472645],
  [3, 0.000022090496998585438],
  [4, 1.541725790028002e-8],
  [5, 1.537459794428035e-12],
  [6, 2.1519736712498913e-17],
  [7, 4.183825607779415e-23],
  [8, 1.1224297172982926e-29],
  [9, 4.137031746513811e-37],
  [10, 2.0884875837625446e-45],
  [11, 1.4408661379436945e-54],
  [12, 1.3562611692059042e-64],
  [13, 1.7395573154667246e-75],
  [14, 3.0372298477503115e-87],
  [15, 7.212994172451208e-100],
  [16, 2.3284857515715305e-113],
  [17, 1.0212280150942608e-127],
  [18, 6.082369231816398e-143],
  [19, 4.917722839256476e-159],
  [20, 5.395865611607901e-176],
  [21, 8.032453871022456e-194],
  [22, 1.6219058609334724e-212],
  [23, 4.441265948088057e-232],
  [24, 1.6489825831519335e-252],
  [25, 8.300172571196523e-274],
  [26, 5.663192408856143e-296],
  [0.5, 0.4795001221869535],
  [1, 0.15729920705028516],
  [1.5, 0.033894853524689274],
  [3, 0.000022090496998585438],
  [10, 2.0884875837625446e-45],
  [20, 5.395865611607901e-176],
  [25, 8.300172571196523e-274],
];
const GAMMA_REFERENCE: readonly (readonly [number, number])[] = [
  [0.1, 9.51350769866873],
  [0.9291666666666666, 1.0461976755091167],
  [1.7583333333333333, 0.9209842228828232],
  [2.5875, 1.4163177758741623],
  [3.4166666666666665, 3.034969993897266],
  [4.245833333333333, 8.239500443570774],
  [5.074999999999999, 26.886699548075853],
  [5.904166666666666, 101.98505561742414],
  [6.7333333333333325, 439.3855891427291],
  [7.562499999999999, 2113.951668582568],
  [8.391666666666666, 11211.103644359844],
  [9.220833333333331, 64871.83473573114],
  [10.049999999999999, 406177.8260348657],
  [10.879166666666666, 2733080.4261579034],
  [11.708333333333332, 19650096.636426892],
  [12.5375, 150218408.2361388],
  [13.366666666666665, 1215882320.4364662],
  [14.195833333333331, 10381746091.660011],
  [15.024999999999999, 93208185321.14206],
  [15.854166666666664, 877399485464.423],
  [16.683333333333334, 8637534396405.851],
  // eslint's no-loss-of-precision reads this one as over-long even though it
  // round-trips exactly; the same double spelled with an exponent satisfies both.
  [17.5125, 8.872266146418763e13],
  [18.341666666666665, 948925563681788.9],
  [19.170833333333334, 10547915432793546],
  [20, 121645100408832000],
  [0.5, 1.7724538509055159],
  [1.5, 0.8862269254527578],
  [2.5, 1.329340388179137],
  [-0.5, -3.544907701811032],
  [-1.5, 2.363271801207355],
  [-2.5, -0.9453087204829418],
  [-4.7, -0.05354127572391971],
  [100, 9.332621544394415e155],
  [171, 7.257415615307998e306],
];
const LGAMMA_REFERENCE: readonly (readonly [number, number])[] = [
  [0.1, 2.2527126517342055],
  [1.3458333333333334, -0.11475683353336884],
  [2.591666666666667, 0.35116939887503507],
  [3.8374999999999995, 1.5914462800412734],
  [5.083333333333333, 3.3043274553274764],
  [6.329166666666667, 5.358722720631954],
  [7.574999999999998, 7.680770735135469],
  [8.820833333333333, 10.22297077565126],
  [10.066666666666666, 12.952177478551311],
  [11.312499999999998, 15.843936692547704],
  [12.558333333333334, 18.879458730028656],
  [13.804166666666665, 22.043852383873915],
  [15.049999999999997, 25.32502458980572],
  [16.295833333333334, 28.712958883253734],
  [17.541666666666668, 32.199222461378625],
  [18.7875, 35.77661790896893],
  [20.033333333333335, 39.43893012118895],
  [21.279166666666665, 43.18073796349224],
  [22.525, 46.99727120529611],
  [23.770833333333336, 50.884299890172805],
  [25.01666666666667, 54.838047440189705],
  [26.2625, 58.85512145182795],
  [27.508333333333333, 62.93245789800734],
  [28.754166666666666, 67.06727563916499],
  [29.999999999999996, 71.257038967168],
  [0.5, 0.5723649429247004],
  [100, 359.1342053695754],
  [1000, 5905.220423209181],
  [1000000, 12815504.569147613],
  [-0.5, 1.265512123484645],
  [-3.7, -1.379739904965825],
];

describe('TdcMath: the statistical four', () => {
  it('erf stays within 4 ulp of libm', () => {
    for (const [x, expected] of ERF_REFERENCE) {
      expect(ulpsApart(TdcMath.erf(x), expected), `erf(${String(x)})`).toBeLessThanOrEqual(4);
    }
  });

  /**
   * Eight rather than four, and the extra is not slack: `erfc` past 1 goes
   * through `e^(-x²)`, and that exponential carries the rounding of the square.
   * The split in `expNegSquare` is what keeps it at eight instead of 445.
   */
  it('erfc stays within 8 ulp of libm', () => {
    for (const [x, expected] of ERFC_REFERENCE) {
      expect(ulpsApart(TdcMath.erfc(x), expected), `erfc(${String(x)})`).toBeLessThanOrEqual(8);
    }
  });

  /**
   * `erfc` is not `1 - erf`, and this is where it shows. The subtraction decays
   * in two stages: at x = 5 it still produces a number, but only the first six
   * of twelve digits are right; by x = 6 erf has rounded to 1 and the answer is
   * gone entirely, though the true value is 2e-17 and perfectly representable.
   */
  it('erfc keeps the value that 1 - erf throws away', () => {
    const half = 1 - TdcMath.erf(5);
    expect(half).toBeGreaterThan(0);
    // Same first six digits as erfc(5), then they part company.
    expect(Math.abs((half - TdcMath.erfc(5)) / TdcMath.erfc(5))).toBeGreaterThan(1e-8);
    expect(Math.abs((half - TdcMath.erfc(5)) / TdcMath.erfc(5))).toBeLessThan(1e-4);

    expect(TdcMath.erf(6)).toBe(1);
    expect(1 - TdcMath.erf(6)).toBe(0);
    expect(TdcMath.erfc(6)).toBeGreaterThan(2e-17);
    expect(TdcMath.erfc(6)).toBeLessThan(3e-17);
    // And it keeps going long after that.
    expect(TdcMath.erfc(20)).toBeGreaterThan(0);
    expect(TdcMath.erfc(26)).toBeGreaterThan(0);
  });

  /**
   * Γ of a whole number is a factorial, and that is what people check first.
   * The dedicated path makes the first twenty-three exact.
   */
  it('gamma is exact on the whole numbers a factorial can hold', () => {
    let factorial = 1;
    for (let n = 1; n <= 23; n += 1) {
      expect(TdcMath.gamma(n), `gamma(${String(n)})`).toBe(factorial);
      factorial *= n;
    }
    expect(TdcMath.gamma(171)).toBeLessThan(Number.POSITIVE_INFINITY);
    expect(TdcMath.gamma(172)).toBe(Number.POSITIVE_INFINITY);
  });

  /**
   * Off the whole numbers, Γ ends in an exponential, so the drift grows with
   * log Γ(x) — the same amplification `pow` has. Twelve significant digits is
   * what survives, and is what is asserted.
   */
  it('gamma keeps twelve significant digits elsewhere', () => {
    for (const [x, expected] of GAMMA_REFERENCE) {
      const relative = Math.abs((TdcMath.gamma(x) - expected) / expected);
      expect(relative, `gamma(${String(x)})`).toBeLessThan(1e-12);
    }
  });

  it('gamma has no value at a pole', () => {
    expect(TdcMath.gamma(0)).toBeNaN();
    expect(TdcMath.gamma(-1)).toBeNaN();
    expect(TdcMath.gamma(-10)).toBeNaN();
    expect(TdcMath.lgamma(0)).toBe(Number.POSITIVE_INFINITY);
    expect(TdcMath.lgamma(-3)).toBe(Number.POSITIVE_INFINITY);
  });

  /**
   * `lgamma` is measured two ways on purpose. It has zeros at 1 and 2, and no
   * method that sums terms of size 1 can be RELATIVELY accurate about their
   * cancelling to nothing — so the relative bound is claimed only where the
   * value is not near zero, and an absolute bound covers the rest.
   */
  it('lgamma stays within 32 ulp where it is not near a zero', () => {
    for (const [x, expected] of LGAMMA_REFERENCE) {
      if (Math.abs(expected) < 1) continue;
      expect(ulpsApart(TdcMath.lgamma(x), expected), `lgamma(${String(x)})`).toBeLessThanOrEqual(
        32,
      );
    }
  });

  it('lgamma stays within 1e-13 in absolute terms, and is exactly zero at both zeros', () => {
    for (const [x, expected] of LGAMMA_REFERENCE) {
      if (x > 30) continue;
      expect(Math.abs(TdcMath.lgamma(x) - expected), `lgamma(${String(x)})`).toBeLessThan(1e-13);
    }
    expect(TdcMath.lgamma(1)).toBe(0);
    expect(TdcMath.lgamma(2)).toBe(0);
  });
});

/**
 * ── The fifth wave ────────────────────────────────────────────────────────────
 *
 * These are checked against IDENTITIES rather than against another libm, which
 * is a stronger reference: ζ(2) is π²/6 exactly, ψ(n) is −γ plus a harmonic
 * sum, β(2,3) is 1/12. A table of numbers copied from somewhere can only say
 * "the same as that implementation"; an identity says "right".
 */

/** Euler–Mascheroni, to the nearest double. */
const EULER_MASCHERONI = 0.5772156649015329;

describe('TdcMath: the fifth wave', () => {
  it('degrees and radians are each other, exactly, at the landmarks', () => {
    expect(TdcMath.degrees(TdcMath.PI)).toBe(180);
    expect(TdcMath.degrees(TdcMath.PI / 2)).toBe(90);
    expect(TdcMath.degrees(0)).toBe(0);
    expect(TdcMath.radians(180)).toBe(TdcMath.PI);
    expect(TdcMath.radians(0)).toBe(0);
    // A round trip is two roundings, so it comes back within an ulp or two.
    for (const x of grid(-720, 720, 289)) {
      expect(ulpsApart(TdcMath.degrees(TdcMath.radians(x)), x)).toBeLessThanOrEqual(2);
    }
  });

  it('beta matches its closed forms', () => {
    // β(a,b) = Γ(a)Γ(b)/Γ(a+b), and these are the cases with an exact answer.
    expect(ulpsApart(TdcMath.beta(2, 3), 1 / 12)).toBeLessThanOrEqual(CEILING);
    expect(ulpsApart(TdcMath.beta(5, 7), 1 / 2310)).toBeLessThanOrEqual(CEILING);
    // β(½,½) = π, the one everybody checks.
    expect(ulpsApart(TdcMath.beta(0.5, 0.5), TdcMath.PI)).toBeLessThanOrEqual(CEILING);
    // β(1,n) = 1/n for every whole n.
    for (let n = 1; n <= 40; n += 1) {
      expect(ulpsApart(TdcMath.beta(1, n), 1 / n), `beta(1, ${String(n)})`).toBeLessThanOrEqual(
        CEILING,
      );
    }
    // Symmetric in its arguments, which the implementation does not assume.
    for (const a of grid(0.5, 12, 24)) {
      for (const b of grid(0.5, 12, 24)) {
        expect(ulpsApart(TdcMath.beta(a, b), TdcMath.beta(b, a))).toBeLessThanOrEqual(CEILING);
      }
    }
    // Past a+b = 171 the direct route would overflow though the answer is tiny.
    expect(TdcMath.beta(100, 100)).toBeGreaterThan(0);
    expect(TdcMath.beta(100, 100)).toBeLessThan(1e-59);
  });

  /**
   * ψ(n) = −γ + H(n−1) is exact for every whole n, so the reference is built
   * here rather than quoted — and it disagrees with a wrong implementation for
   * a reason, not by a table lookup.
   */
  it('digamma matches the harmonic sum at whole numbers', () => {
    let harmonic = 0;
    for (let n = 1; n <= 40; n += 1) {
      const expected = -EULER_MASCHERONI + harmonic;
      expect(ulpsApart(TdcMath.digamma(n), expected), `digamma(${String(n)})`).toBeLessThanOrEqual(
        8,
      );
      harmonic += 1 / n;
    }
  });

  it('digamma matches its other closed forms', () => {
    // ψ(½) = −γ − 2·log 2
    expect(
      ulpsApart(TdcMath.digamma(0.5), -EULER_MASCHERONI - 2 * TdcMath.log(2)),
    ).toBeLessThanOrEqual(8);
    /*
     * The recurrence it is built on, checked against itself off the grid.
     *
     * The tolerance scales with the CANCELLATION in the check rather than being
     * a constant, because the identity is ill-conditioned where the two sides
     * are large and their sum is small: at x = 0.3, ψ(x) is −3.50 and 1/x is
     * 3.33, so the reference expression loses a factor of twenty before digamma
     * is even involved. A flat bound there would be measuring the test.
     */
    for (const x of grid(0.3, 20, 60)) {
      const left = TdcMath.digamma(x + 1);
      const cancellation = Math.max(1, Math.abs(TdcMath.digamma(x)) / Math.abs(left));
      expect(
        ulpsApart(left, TdcMath.digamma(x) + 1 / x),
        `digamma recurrence at ${String(x)}`,
      ).toBeLessThanOrEqual(8 * cancellation);
    }
    expect(TdcMath.digamma(0)).toBeNaN();
    expect(TdcMath.digamma(-2)).toBeNaN();
  });

  /**
   * Every one of these is a closed form: ζ at the even numbers is a power of π
   * over a whole number, and at the negative odd numbers it is a rational.
   */
  it('zeta matches its closed forms', () => {
    const pi = TdcMath.PI;
    const cases: readonly (readonly [number, number])[] = [
      [2, (pi * pi) / 6],
      [4, (pi * pi * pi * pi) / 90],
      [6, (pi * pi * pi * pi * pi * pi) / 945],
      [8, TdcMath.pow(pi, 8) / 9450],
      [-1, -1 / 12],
      [-3, 1 / 120],
      [-5, -1 / 252],
      [0, -0.5],
    ];
    for (const [s, expected] of cases) {
      expect(ulpsApart(TdcMath.zeta(s), expected), `zeta(${String(s)})`).toBeLessThanOrEqual(8);
    }
    // Apéry's constant, which has no closed form and is quoted.
    // Apéry's constant, 1.2020569031595942854…, whose nearest double ends 942.
    expect(ulpsApart(TdcMath.zeta(3), 1.2020569031595942)).toBeLessThanOrEqual(8);
    expect(TdcMath.zeta(1)).toBe(Number.POSITIVE_INFINITY);
    // The trivial zeros.
    for (const s of [-2, -4, -6, -8]) {
      expect(Math.abs(TdcMath.zeta(s)), `zeta(${String(s)})`).toBeLessThan(1e-15);
    }
    // Far out it approaches 1 from above.
    expect(TdcMath.zeta(50)).toBeGreaterThan(1);
    expect(TdcMath.zeta(50)).toBeLessThan(1 + 1e-14);
  });
});
