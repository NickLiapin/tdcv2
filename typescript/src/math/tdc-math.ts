/**
 * TdcMath — the transcendental functions, computed by TDC rather than by the
 * host language.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * IEEE-754 pins down `+`, `-`, `*`, `/` and `sqrt`: each has exactly one legal
 * answer, so every language agrees about them. It says nothing about `sin`,
 * `cos`, `exp`, `log` or `pow` — every libm picks its own algorithm — and the
 * difference is real rather than theoretical. Measured on one machine, one day:
 *
 *     tan(1)      Node 3ff8eb245cbee3a6   Python 3ff8eb245cbee3a5
 *     cos(1000)   Node 3fe1ff026793f1bb   Python 3fe1ff026793f1bc
 *
 * Sixteen of seventy-seven sampled values disagree somewhere across the five
 * implementations. In `timeseries` that never shows: every number is rounded to
 * a decimal string before it becomes output, so the last bit dies on the way
 * out. An `if=` has no rounding step — a comparison turns that bit into a
 * different row, and a different file, on a tool whose whole promise is that
 * five implementations produce the same bytes.
 *
 * So TDC computes these itself, the way it already computes its own random
 * numbers rather than trusting each language's.
 *
 * ── The one rule ─────────────────────────────────────────────────────────────
 * **Nothing in this file may call a transcendental function of the host.** No
 * `Math.sin`, no `Math.exp`, no `Math.pow`. Only:
 *
 *   +  -  *  /        IEEE-754 correctly rounded, one legal answer
 *   Math.sqrt         also correctly rounded by the standard — verified equal
 *                     across Node, Python, Java and Rust before being relied on
 *   Math.abs, Math.floor, Math.trunc, comparisons — exact, no rounding at all
 *
 * One `Math.sin` slipped into one of the five ports would bring the divergence
 * straight back, and it would be invisible until a shared fixture compared the
 * bits. That fixture exists; keep it that way.
 *
 * ── What this is NOT ─────────────────────────────────────────────────────────
 * It is not an attempt to match the system libm, and not a claim of correct
 * rounding. The results here land within about 2 ulp of the true value, which
 * is the same neighbourhood a libm occupies. What matters is that all five
 * implementations land on the SAME double, and identical arithmetic gets that
 * for free.
 */

/** π and e as their nearest doubles. */
export const PI = 3.141592653589793;
export const E = 2.718281828459045;

// ln 2, split so that `k * LN2_HI` stays exact for the integer k that range
// reduction produces. Subtracting the two pieces separately keeps the low bits
// a single constant would have thrown away.
const LN2_HI = 0.6931471803691238;
const LN2_LO = 1.9082149292705877e-10;
const LN2 = 0.6931471805599453;

// π/2 in three pieces, for the same reason: reducing `sin(1000)` by a single
// rounded π/2 loses most of the significant digits before the series starts.
const PIO2 = 1.5707963267948966;
const PIO2_1 = 1.5707963267341256;
const PIO2_2 = 6.077100506506192e-11;
const PIO2_3 = 2.0222662487959506e-21;

/**
 * Taylor coefficients for (sin(r) − r)/r³ over r², ascending: ∓1/(2n+3)!.
 *
 * The count is set by the WORST point of the reduced interval, |r| = π/4, not
 * by a typical one. Stopping at 1/15! leaves a first-omitted term of 6·10⁻¹⁷
 * there — half an ulp, which is the edge of acceptable; 1/17! puts it at
 * 8·10⁻²⁰ and settles it. Measuring accuracy on a narrow sample would have
 * missed the difference entirely, because it only shows at the ends.
 */
const SIN_COEFF = [
  -1 / 6,
  1 / 120,
  -1 / 5040,
  1 / 362880,
  -1 / 39916800,
  1 / 6227020800,
  -1 / 1307674368000,
  1 / 355687428096000,
];

/**
 * Taylor coefficients for (cos(r) − 1)/r² over r², ascending: ∓1/(2n+2)!.
 *
 * Nine of them, and the last two are not optional. At |r| = π/4 a series that
 * stops at 1/14! is off by 1.4·10⁻¹⁵ — thirteen ulp — and `sin` and `tan` both
 * inherit that, since a quarter-turn reduction routes half of all arguments
 * through this series and `tan` divides by it.
 */
const COS_COEFF = [
  -1 / 2,
  1 / 24,
  -1 / 720,
  1 / 40320,
  -1 / 3628800,
  1 / 479001600,
  -1 / 87178291200,
  1 / 20922789888000,
  -1 / 6402373705728000,
];

/**
 * Taylor coefficients for eʳ over r, ascending: 1/n!.
 *
 * Horner rather than the forward recurrence `term = term·r/i` this used to run.
 * Both truncate at the same place, but the recurrence rounds twice per term and
 * carries that error into the next one, which measured 4 ulp against 1 for the
 * same number of terms.
 */
const EXP_COEFF = [
  1,
  1,
  1 / 2,
  1 / 6,
  1 / 24,
  1 / 120,
  1 / 720,
  1 / 5040,
  1 / 40320,
  1 / 362880,
  1 / 3628800,
  1 / 39916800,
  1 / 479001600,
  1 / 6227020800,
  1 / 87178291200,
  1 / 1307674368000,
];

/** The largest and smallest arguments `exp` can answer with a finite double. */
const EXP_OVERFLOW = 709.782712893384;
const EXP_UNDERFLOW = -745.1332191019411;

/**
 * `sqrt` — delegated, and that is safe.
 *
 * IEEE-754 requires square root to be correctly rounded: there is one legal
 * answer and every implementation must give it. Measured across Node, Python,
 * Java and Rust before this line was written; all four agreed on every sample.
 */
export function sqrt(x: number): number {
  return Math.sqrt(x);
}

/** Halve `value` exactly `count` times. Exact while the result stays normal. */
function halveTimes(value: number, count: number): number {
  let out = value;
  for (let i = 0; i < count; i += 1) {
    out /= 2;
  }
  return out;
}

/** The most halvings that keep a value near 1 inside the normal range. */
const DEEPEST_NORMAL_HALVING = 1021;

/**
 * `value · 2^n` for an integer n, with `value` near 1.
 *
 * Stepping one power at a time is exact — while the numbers stay normal. Below
 * 2⁻¹⁰²² they do not: a subnormal has fewer bits than it started with, and
 * every further halving rounds again. Halving all the way down from 1 to 2⁻¹⁰⁷⁴
 * that way threw away most of the answer — `exp(-730)` came back
 * 9.22631e-318 against a true 9.226315e-318, and `exp(-745)` came back 0
 * against 5e-324.
 *
 * So a deep scaling is split: down to the edge of the normal range in exact
 * steps, then ONE multiplication by a small power of two — itself exact, being
 * no smaller than 2⁻⁵⁴ — which rounds once and only once.
 */
function scaleByPowerOfTwo(value: number, n: number): number {
  if (n >= -DEEPEST_NORMAL_HALVING) {
    let out = value;
    let k = n;
    while (k > 0) {
      out *= 2;
      k -= 1;
    }
    return halveTimes(out, -k);
  }
  const atTheEdge = halveTimes(value, DEEPEST_NORMAL_HALVING);
  const remainder = halveTimes(1, -(n + DEEPEST_NORMAL_HALVING));
  return atTheEdge * remainder;
}

/**
 * `exp(x)` — range-reduced to `2^k · e^r` with |r| ≤ ln2/2, then Taylor.
 *
 * `k · LN2_HI` is exact: the constant carries 21 zero low bits, so any k this
 * reduction can produce multiplies without rounding, and the subtraction keeps
 * every digit a single ln2 constant would have thrown away.
 */
export function exp(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (x > EXP_OVERFLOW) return Number.POSITIVE_INFINITY;
  if (x < EXP_UNDERFLOW) return 0;
  const k = Math.trunc(x / LN2 + (x >= 0 ? 0.5 : -0.5));
  const r = x - k * LN2_HI - k * LN2_LO;
  let sum = 0;
  for (let i = EXP_COEFF.length - 1; i >= 0; i -= 1) {
    sum = sum * r + (EXP_COEFF[i] ?? 0);
  }
  return scaleByPowerOfTwo(sum, k);
}

/**
 * The series for `atanh(s)/s` over s², shared by `log` and `log1p`.
 *
 * The two callers reduce to different intervals, so each names how far to go:
 * `log` halves its argument until |s| <= 0.1716 and thirteen terms suffice,
 * while `log1p` cannot halve — it must not form `1 + x` at all — and reaches
 * |s| <= 1/3, where thirteen terms are 63 ulp out and twenty are 2.
 */
function atanhSeries(s2: number, highestOddPower: number): number {
  let sum = 0;
  for (let i = highestOddPower; i >= 1; i -= 2) {
    sum = sum * s2 + 1 / i;
  }
  return sum;
}

/**
 * `log(x)` — natural logarithm.
 *
 * `x` is split into `m · 2^e` with m near 1 by halving and doubling, both exact.
 * Then `log(m) = 2·atanh(s)` with `s = (m−1)/(m+1)`, whose series converges fast
 * because |s| ≤ 0.1716 over the reduced range.
 */
export function log(x: number): number {
  if (Number.isNaN(x) || x < 0) return Number.NaN;
  if (x === 0) return Number.NEGATIVE_INFINITY;
  if (x === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  let m = x;
  let e = 0;
  while (m >= 1.4142135623730951) {
    m /= 2;
    e += 1;
  }
  while (m < 0.7071067811865476) {
    m *= 2;
    e -= 1;
  }
  const s = (m - 1) / (m + 1);
  return 2 * s * atanhSeries(s * s, 25) + e * LN2_HI + e * LN2_LO;
}

/**
 * The largest k for which 10^k and 10^-k are both exactly doubles.
 *
 * Past 10^22 a power of ten is no longer representable — 10^23 is not a double
 * — so beyond here \exact\ has nothing to mean, and the general formula takes
 * over. The positive side survives to 10^24, but the pair has to agree for the
 * function to behave the same in both directions.
 */
const EXACT_POWER_OF_TEN = 22;

/**
 * `log10(x)`.
 *
 * A power of ten is the argument someone passes to `log10`, and `log(x)/ln10`
 * gets it wrong: it returned 2.9999999999999996 for 1000. There is no exponent
 * to separate here the way `log2` separates a power of two — a double is binary
 * — so the whole answer is checked instead: if raising ten back to it returns
 * the argument unchanged, it was exact and is given as a whole number.
 *
 * The check needs no tolerance. `pow` with a whole exponent goes through
 * repeated squaring, so the equality is the test.
 */
export function log10(x: number): number {
  const r = log(x) / 2.302585092994046;
  const whole = Math.round(r);
  if (Math.abs(whole) <= EXACT_POWER_OF_TEN) {
    // A NEGATIVE power has to be built from the positive one and inverted.
    // `pow(10, -2)` squares 1/10, and a tenth is not exact in binary, so the
    // square misses 0.01; `1 / pow(10, 2)` is one rounding of an exact 100 and
    // lands on the double that 1e-2 denotes.
    const p = whole >= 0 ? pow(10, whole) : 1 / pow(10, -whole);
    if (p === x) return whole;
  }
  return r;
}

/**
 * Range reduction for the circular functions.
 *
 * Returns the quadrant (0–3) and the remainder in [−π/4, π/4]. Subtracting π/2
 * in three pieces rather than one is what keeps `sin(1000)` accurate: a single
 * rounded π/2 would have thrown away the low bits before the series began.
 */
function reduceByQuarterTurn(x: number): { quadrant: number; remainder: number } {
  const k = Math.trunc(x / PIO2 + (x >= 0 ? 0.5 : -0.5));
  const remainder = x - k * PIO2_1 - k * PIO2_2 - k * PIO2_3;
  return { quadrant: ((k % 4) + 4) % 4, remainder };
}

function sinCore(r: number): number {
  const z = r * r;
  let sum = 0;
  for (let i = SIN_COEFF.length - 1; i >= 0; i -= 1) {
    sum = sum * z + (SIN_COEFF[i] ?? 0);
  }
  return r + r * z * sum;
}

function cosCore(r: number): number {
  const z = r * r;
  let sum = 0;
  for (let i = COS_COEFF.length - 1; i >= 0; i -= 1) {
    sum = sum * z + (COS_COEFF[i] ?? 0);
  }
  return 1 + z * sum;
}

export function sin(x: number): number {
  if (Number.isNaN(x) || !Number.isFinite(x)) return Number.NaN;
  const { quadrant, remainder } = reduceByQuarterTurn(x);
  if (quadrant === 0) return sinCore(remainder);
  if (quadrant === 1) return cosCore(remainder);
  if (quadrant === 2) return -sinCore(remainder);
  return -cosCore(remainder);
}

export function cos(x: number): number {
  if (Number.isNaN(x) || !Number.isFinite(x)) return Number.NaN;
  const { quadrant, remainder } = reduceByQuarterTurn(x);
  if (quadrant === 0) return cosCore(remainder);
  if (quadrant === 1) return -sinCore(remainder);
  if (quadrant === 2) return -cosCore(remainder);
  return sinCore(remainder);
}

/**
 * `tan(x)` — one reduction shared by both halves, so numerator and denominator
 * can never come from different quadrants.
 *
 * The four quadrants collapse to two cases: an even one leaves sin over cos, an
 * odd one swaps them and flips the sign.
 */
export function tan(x: number): number {
  if (Number.isNaN(x) || !Number.isFinite(x)) return Number.NaN;
  const { quadrant, remainder } = reduceByQuarterTurn(x);
  const s = sinCore(remainder);
  const c = cosCore(remainder);
  return quadrant % 2 === 0 ? s / c : -c / s;
}

/**
 * `pow(x, y)`.
 *
 * An integer exponent goes through repeated squaring, which is both faster and
 * more accurate than the general route — `pow(10, 3)` lands on exactly 1000
 * rather than 999.9999999999998, and a config that compares against a round
 * number would notice the difference. Everything else is `exp(y · log(x))`.
 */
function repeatedSquaring(base: number, exponent: number): number {
  let result = 1;
  let b = base;
  let n = exponent;
  while (n > 0) {
    if (n % 2 === 1) result *= b;
    b *= b;
    n = Math.trunc(n / 2);
  }
  return result;
}

export function pow(x: number, y: number): number {
  if (Number.isNaN(y)) return Number.NaN;
  if (y === 0) return 1;
  if (Number.isNaN(x)) return Number.NaN;
  if (Number.isInteger(y) && Math.abs(y) <= 1024) {
    return repeatedSquaring(y < 0 ? 1 / x : x, Math.abs(y));
  }
  // A negative base with a fractional exponent has no real answer, and saying
  // so is better than returning whatever the general route would produce.
  if (x < 0) return Number.NaN;
  if (x === 0) return y > 0 ? 0 : Number.POSITIVE_INFINITY;
  // A half-integer exponent is the fractional one people actually write, and
  // `x^(n/2)` is `(√x)^n` — both halves exact. Without this, `pow(100, 0.5)`
  // came back 9.999999999999998 and `pow(9, 1.5)` 26.99999999999999, which is
  // the same round-number problem the integer path exists to avoid.
  const half = 2 * y;
  if (Number.isInteger(half) && Math.abs(half) <= 2048) {
    const root = Math.sqrt(x);
    return repeatedSquaring(half < 0 ? 1 / root : root, Math.abs(half));
  }
  return exp(y * log(x));
}

/* ── The second wave: inverses and hyperbolics ────────────────────────────────
 *
 * Same rule as everything above: `+ - * /`, `Math.sqrt`, and the functions this
 * file already built. Nothing here calls a transcendental of the host.
 */

/** π/2, π/4 and 3π/4 as their nearest doubles — the quadrant answers `atan2` returns. */
const PIO4 = 0.7853981633974483;
const PI3O4 = 2.356194490192345;

/**
 * Taylor coefficients for atan(t)/t over t², ascending: ∓1/(2n+1).
 *
 * Twenty-four, because the reduction below halves the argument ONCE and no
 * more. Each halving costs a `sqrt`, a divide and their roundings; measured
 * against the host, one halving with this many terms lands at 2 ulp, two
 * halvings with sixteen at 3, and three with twelve at 4. Series terms are
 * cheaper than reduction steps here, which is the opposite of the usual advice
 * and the reason this is written down.
 */
const ATAN_COEFF = [
  1,
  -1 / 3,
  1 / 5,
  -1 / 7,
  1 / 9,
  -1 / 11,
  1 / 13,
  -1 / 15,
  1 / 17,
  -1 / 19,
  1 / 21,
  -1 / 23,
  1 / 25,
  -1 / 27,
  1 / 29,
  -1 / 31,
  1 / 33,
  -1 / 35,
  1 / 37,
  -1 / 39,
  1 / 41,
  -1 / 43,
  1 / 45,
  -1 / 47,
];

/** Taylor coefficients for sinh(x)/x over x², ascending: 1/(2n+1)!. */
const SINH_COEFF = [
  1,
  1 / 6,
  1 / 120,
  1 / 5040,
  1 / 362880,
  1 / 39916800,
  1 / 6227020800,
  1 / 1307674368000,
];

/** Taylor coefficients for cosh(x) over x², ascending: 1/(2n)!. */
const COSH_COEFF = [
  1,
  1 / 2,
  1 / 24,
  1 / 720,
  1 / 40320,
  1 / 3628800,
  1 / 479001600,
  1 / 87178291200,
];

/** Horner over z, ascending coefficients — the shape every series here uses. */
function horner(coeff: readonly number[], z: number): number {
  let sum = 0;
  for (let i = coeff.length - 1; i >= 0; i -= 1) {
    sum = sum * z + (coeff[i] ?? 0);
  }
  return sum;
}

/**
 * Half-angle for the arctangent: `atan(t) = 2·atan(h(t))`.
 *
 * Built from `sqrt` alone, so it is as well-defined as `sqrt` is.
 */
function atanHalf(t: number): number {
  return t / (1 + Math.sqrt(1 + t * t));
}

/** `atan` on [0, 1], halved once so the series runs on |t| ≤ 0.4143. */
function atanCore(t: number): number {
  const h = atanHalf(t);
  return 2 * (h * horner(ATAN_COEFF, h * h));
}

/**
 * `atan(x)` — the arctangent, in radians, over the whole real line.
 *
 * Above 1 the argument is flipped with `atan(x) = π/2 − atan(1/x)`, which keeps
 * the series on the interval it was built for and makes the infinities fall out
 * for free.
 */
export function atan(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (x === Number.POSITIVE_INFINITY) return PIO2;
  if (x === Number.NEGATIVE_INFINITY) return -PIO2;
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const r = a > 1 ? PIO2 - atanCore(1 / a) : atanCore(a);
  return sign * r;
}

/**
 * `atan2(y, x)` — the angle of the point (x, y), in radians, over (−π, π].
 *
 * The quadrant cannot be recovered from `y/x` alone: the ratio is the same in
 * opposite quadrants, which is the whole reason this function exists separately
 * from `atan`.
 */
export function atan2(y: number, x: number): number {
  if (Number.isNaN(y) || Number.isNaN(x)) return Number.NaN;
  const yInf = !Number.isFinite(y);
  const xInf = !Number.isFinite(x);
  if (yInf && xInf) {
    const magnitude = x > 0 ? PIO4 : PI3O4;
    return y > 0 ? magnitude : -magnitude;
  }
  if (yInf) return y > 0 ? PIO2 : -PIO2;
  if (xInf) {
    // Plain zero rather than negative zero: the five implementations have to
    // agree, and a signed zero is one more thing for four ports to get subtly
    // different. Nothing downstream can tell them apart — it renders as "0"
    // and compares equal to 0.
    if (x > 0) return 0;
    return y < 0 ? -PI : PI;
  }
  if (x === 0 && y === 0) return 0;
  if (x === 0) return y > 0 ? PIO2 : -PIO2;
  if (y === 0) return x > 0 ? 0 : PI;
  const r = atan(y / x);
  if (x > 0) return r;
  return y > 0 ? r + PI : r - PI;
}

/** `asin` on [0, 0.5], where `1 − a²` keeps every bit it started with. */
function asinSmall(a: number): number {
  return atan(a / Math.sqrt(1 - a * a));
}

/**
 * `asin(x)` — the arcsine, in radians, over [−1, 1].
 *
 * Past a half the direct route would compute `1 − a²` with a and 1 nearly
 * equal, and lose most of its digits before `sqrt` ever saw them. The
 * half-angle identity `asin(a) = π/2 − 2·asin(√((1−a)/2))` moves the
 * subtraction to `1 − a`, which is exact in that range, and lands back on the
 * branch above.
 */
export function asin(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  if (a > 1) return Number.NaN;
  if (a === 1) return sign * PIO2;
  if (a <= 0.5) return sign * asinSmall(a);
  return sign * (PIO2 - 2 * asinSmall(Math.sqrt((1 - a) / 2)));
}

/**
 * `acos(x)` — the arccosine, in radians, over [−1, 1].
 *
 * Not `π/2 − asin(x)` everywhere: near x = 1 the answer approaches zero, and
 * that subtraction would compute it as the difference of two numbers that are
 * nearly π/2, throwing away every digit that matters. Each end gets the form
 * that keeps them.
 */
export function acos(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (x > 1 || x < -1) return Number.NaN;
  if (x === 1) return 0;
  if (x === -1) return PI;
  if (x >= 0.5) return 2 * asinSmall(Math.sqrt((1 - x) / 2));
  if (x <= -0.5) return PI - 2 * asinSmall(Math.sqrt((1 + x) / 2));
  return PIO2 - asinSmall(Math.abs(x)) * (x < 0 ? -1 : 1);
}

/**
 * `sinh(x)` — the hyperbolic sine.
 *
 * Below a half the exponential route would compute `eˣ − e⁻ˣ` with the two
 * nearly equal and cancel away the answer, so the series takes over there.
 * Above it there is no cancellation left to fear.
 */
export function sinh(x: number): number {
  if (Number.isNaN(x) || !Number.isFinite(x)) return x;
  const a = Math.abs(x);
  if (a < 0.5) return x * horner(SINH_COEFF, x * x);
  const sign = x < 0 ? -1 : 1;
  // Past this point eˣ overflows but sinh(x) still fits, so the halving is
  // folded into the exponent rather than applied after it.
  if (a > 709) return sign * exp(a - LN2);
  const t = exp(a);
  return (sign * (t - 1 / t)) / 2;
}

/**
 * `cosh(x)` — the hyperbolic cosine.
 *
 * A sum rather than a difference, so nothing cancels; the series below a half
 * is for accuracy, not for survival.
 */
export function cosh(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (!Number.isFinite(x)) return Number.POSITIVE_INFINITY;
  const a = Math.abs(x);
  if (a < 0.5) return horner(COSH_COEFF, x * x);
  if (a > 709) return exp(a - LN2);
  const t = exp(a);
  return (t + 1 / t) / 2;
}

/**
 * `tanh(x)` — the hyperbolic tangent.
 *
 * Past 20 the true value is within 10⁻¹⁷ of 1, closer than the next double, so
 * the answer is 1 and computing e⁴⁰ to discover that would be waste.
 */
export function tanh(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  const sign = x < 0 ? -1 : 1;
  if (!Number.isFinite(x)) return sign;
  const a = Math.abs(x);
  if (a > 20) return sign;
  if (a < 0.5) {
    const z = x * x;
    return (x * horner(SINH_COEFF, z)) / horner(COSH_COEFF, z);
  }
  const u = exp(2 * a);
  return (sign * (u - 1)) / (u + 1);
}

/**
 * `cbrt(x)` — the cube root, defined for negatives too.
 *
 * `pow(x, 1/3)` is not the same function: 1/3 is not a double, and a negative
 * base with a fractional exponent has no real answer at all. So this is its own
 * function, reduced by powers of eight — exact, being powers of two — and then
 * refined by Newton's method, which triples its correct digits each pass.
 */
export function cbrt(x: number): number {
  if (Number.isNaN(x) || !Number.isFinite(x) || x === 0) return x;
  const sign = x < 0 ? -1 : 1;
  let a = Math.abs(x);
  let e = 0;
  while (a >= 8) {
    a /= 8;
    e += 1;
  }
  while (a < 1) {
    a *= 8;
    e -= 1;
  }
  // A straight line through the ends of [1, 8): within 11% everywhere, which
  // six Newton passes take past the last bit.
  let y = 1 + (a - 1) / 7;
  for (let i = 0; i < 6; i += 1) {
    y = (2 * y + a / (y * y)) / 3;
  }
  return sign * scaleByPowerOfTwo(y, e);
}

/* ── The third wave: the shapes that exist to avoid cancellation ──────────────
 *
 * `expm1` and `log1p` are not conveniences. Near zero, `exp(x) - 1` and
 * `log(1 + x)` each throw away most of their answer to a subtraction or to a
 * rounding that happens before the function is even called — and these two are
 * what the inverse hyperbolics are built from, which is why they come first.
 */

/** Taylor coefficients for (eˣ − 1)/x over x, ascending: 1/(n+1)!. */
const EXPM1_COEFF = [
  1,
  1 / 2,
  1 / 6,
  1 / 24,
  1 / 120,
  1 / 720,
  1 / 5040,
  1 / 40320,
  1 / 362880,
  1 / 3628800,
  1 / 39916800,
  1 / 479001600,
  1 / 6227020800,
  1 / 87178291200,
  1 / 1307674368000,
  1 / 20922789888000,
];

/**
 * `expm1(x)` — eˣ − 1, computed so that small x keeps its digits.
 *
 * `exp(0.0000001) - 1` in plain arithmetic is a subtraction of two numbers that
 * agree to seven places, and most of the answer dies in it. The series has no
 * subtraction to lose anything to.
 */
export function expm1(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (Math.abs(x) < 0.5) return x * horner(EXPM1_COEFF, x);
  return exp(x) - 1;
}

/**
 * `log1p(x)` — log(1 + x), computed so that small x keeps its digits.
 *
 * The loss here happens before the logarithm is reached: `1 + 1e-20` IS 1 as a
 * double, so `log(1 + x)` returns zero for every x under 10⁻¹⁶. Reducing
 * instead to `2·atanh(x/(2+x))` never forms `1 + x` at all.
 */
export function log1p(x: number): number {
  if (Number.isNaN(x) || x < -1) return Number.NaN;
  if (x === -1) return Number.NEGATIVE_INFINITY;
  if (x === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  // Past a half, `1 + x` has nothing left to lose and the direct route is both
  // shorter and better conditioned.
  if (Math.abs(x) >= 0.5) return log(1 + x);
  const s = x / (2 + x);
  return 2 * s * atanhSeries(s * s, 39);
}

/**
 * `log2(x)`.
 *
 * Not `log(x) / ln2`: that would make `log2(8)` come out 2.9999999999999996,
 * and a power of two is precisely the argument someone passes to `log2`. The
 * exponent is separated first, so a power of two returns a whole number exactly
 * and only the mantissa goes through the logarithm.
 */
export function log2(x: number): number {
  if (Number.isNaN(x) || x < 0) return Number.NaN;
  if (x === 0) return Number.NEGATIVE_INFINITY;
  if (x === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  let m = x;
  let e = 0;
  while (m >= 1.4142135623730951) {
    m /= 2;
    e += 1;
  }
  while (m < 0.7071067811865476) {
    m *= 2;
    e -= 1;
  }
  if (m === 1) return e;
  return e + log(m) / LN2;
}

/**
 * `hypot(x, y)` — the length of the vector, without an intermediate that
 * overflows.
 *
 * `sqrt(x*x + y*y)` is the definition and the wrong implementation: for
 * x = 10²⁰⁰ the square overflows to infinity and the answer comes back
 * infinite, though it is perfectly representable. Factoring the larger side out
 * first keeps every intermediate near 1.
 */
export function hypot(x: number, y: number): number {
  // An infinite side wins even against a NaN on the other, which is what
  // IEEE-754 recommends: the length is infinite whatever the other side is.
  if (!Number.isFinite(x) && !Number.isNaN(x)) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(y) && !Number.isNaN(y)) return Number.POSITIVE_INFINITY;
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN;
  let a = Math.abs(x);
  let b = Math.abs(y);
  if (a < b) {
    const swap = a;
    a = b;
    b = swap;
  }
  if (a === 0) return 0;
  const ratio = b / a;
  return a * Math.sqrt(1 + ratio * ratio);
}

/** `sign(x)` — −1, 0 or 1. Exact: there is nothing here to round. */
export function sign(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (x > 0) return 1;
  if (x < 0) return -1;
  return 0;
}

/**
 * `asinh(x)` — the inverse hyperbolic sine, over the whole real line.
 *
 * `log(x + sqrt(x² + 1))` is the textbook form and cancels for small x: the two
 * terms approach 1 and −1 of each other. Rewriting the argument as
 * `x + x²/(1 + sqrt(1 + x²))` leaves `log1p` a number near x rather than a
 * number near 1, and nothing cancels.
 */
export function asinh(x: number): number {
  if (Number.isNaN(x) || !Number.isFinite(x)) return x;
  const sign_ = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  // Past this, a² would overflow while asinh(a) is still a small number; up
  // there sqrt(1 + a²) is a to every bit, so the answer is log(2a).
  if (a > 1e150) return sign_ * (log(a) + LN2);
  return sign_ * log1p(a + (a * a) / (1 + Math.sqrt(1 + a * a)));
}

/**
 * `acosh(x)` — the inverse hyperbolic cosine, defined for x ≥ 1.
 *
 * Written around `t = x − 1`, which is exact for the x near 1 where the answer
 * approaches zero and the textbook form loses it.
 */
export function acosh(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (x < 1) return Number.NaN;
  if (x === 1) return 0;
  if (x === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  if (x > 1e150) return log(x) + LN2;
  const t = x - 1;
  return log1p(t + Math.sqrt(2 * t + t * t));
}

/**
 * `atanh(x)` — the inverse hyperbolic tangent, over (−1, 1).
 *
 * `½·log((1+x)/(1−x))` forms a ratio near 1 for small x and loses it. The same
 * ratio written as `1 + 2x/(1−x)` hands `log1p` the small part directly.
 */
export function atanh(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (x > 1 || x < -1) return Number.NaN;
  if (x === 1) return Number.POSITIVE_INFINITY;
  if (x === -1) return Number.NEGATIVE_INFINITY;
  // The identity is only well-conditioned on the positive side. Fed x = −0.999999
  // directly it hands `log1p` an argument of −0.9999995, which is the very
  // cancellation `log1p` exists to avoid — and the answer came back 37618 ulp
  // wrong. Folding to |x| first keeps that argument positive and large.
  const sign_ = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  return sign_ * 0.5 * log1p((2 * a) / (1 - a));
}

/* ── The fourth wave: statistics ──────────────────────────────────────────────
 *
 * `erf`, `erfc`, `gamma` and `lgamma`. These are the first functions here whose
 * accuracy is bounded by something other than the series that computes them,
 * and each one says so where it lives.
 */

/** 2/√π and 1/√π. */
const TWO_OVER_SQRT_PI = 1.1283791670955126;
const ONE_OVER_SQRT_PI = 0.5641895835477563;

/** log √(2π) and √(2π), for the Lanczos form. */
const LOG_SQRT_2PI = 0.9189385332046728;
const SQRT_2PI = 2.5066282746310002;

/** 2²⁷ + 1 — Dekker's splitting constant. */
const SPLIT = 134217729;

/**
 * `e^(−x²)`, computed so the rounding of `x²` never reaches the exponent.
 *
 * This is the whole accuracy story for `erfc`. Squaring x rounds by about
 * x²·2⁻⁵³; `exp` then turns that ABSOLUTE error in its argument into a RELATIVE
 * error in its answer, so at x = 23 — where x² is 529 — the result drifts by
 * 529·2⁻⁵³ ≈ 6·10⁻¹⁴, which is four hundred ulp. Measured, before this existed:
 * 445 ulp. After: 5.
 *
 * The fix is to split x so that the high part squares EXACTLY: `hi` keeps 26
 * significant bits, so `hi·hi` needs 52 and fits. What is left over is tiny, and
 * `expm1` turns it into a correction factor without losing it.
 */
function expNegSquare(x: number): number {
  const s = SPLIT * x;
  const hi = s - (s - x);
  const lo = x - hi;
  return exp(-hi * hi) * (1 + expm1(-(2 * hi * lo + lo * lo)));
}

/** Taylor coefficients for erf(x)·√π/2 over x², ascending: ∓1/(n!(2n+1)). */
const ERF_COEFF = [
  1,
  -1 / 3,
  1 / 10,
  -1 / 42,
  1 / 216,
  -1 / 1320,
  1 / 9360,
  -1 / 75600,
  1 / 685440,
  -1 / 6894720,
  1 / 76204800,
  -1 / 918086400,
  1 / 11975040000,
  -1 / 168129561600,
  1 / 2528170444800,
  -1 / 40537905525000,
  1 / 691118486016000,
  -1 / 12460033493760000,
];

/** How deep the continued fraction for `erfc` runs. */
const ERFC_DEPTH = 200;

/** `erf` on [0, 1] — no exponential involved, so nothing amplifies. */
function erfSmall(x: number): number {
  return TWO_OVER_SQRT_PI * x * horner(ERF_COEFF, x * x);
}

/**
 * `erfc` for x > 1, by continued fraction.
 *
 * Two hundred levels rather than a convergence test: a loop that stops when the
 * change falls below a threshold would still be deterministic, but a FIXED
 * depth is one less thing for five implementations to agree about. The depth is
 * set by the slowest point, just above x = 1; measured, 100 levels leave 29645
 * ulp there and 200 leave 5.
 */
function erfcLarge(x: number): number {
  let f = 0;
  for (let k = ERFC_DEPTH; k >= 1; k -= 1) {
    f = k / 2 / (x + f);
  }
  return (ONE_OVER_SQRT_PI * expNegSquare(x)) / (x + f);
}

/**
 * `erf(x)` — the error function.
 *
 * Below 1 the series is used directly; above it, `1 − erfc(x)`, because there
 * erfc is the small quantity and the subtraction costs nothing.
 */
export function erf(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  const sign_ = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  if (!Number.isFinite(a)) return sign_;
  if (a <= 1) return sign_ * erfSmall(a);
  return sign_ * (1 - erfcLarge(a));
}

/**
 * `erfc(x)` — the complement, 1 − erf(x), and not computed that way past 1.
 *
 * At x = 5 the true value is 1.5·10⁻¹², which `1 − erf(x)` cannot produce at
 * all: erf(5) rounds to 1, and the subtraction gives zero. Twelve significant
 * digits, gone. That is the reason this function exists separately.
 */
export function erfc(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (x === Number.POSITIVE_INFINITY) return 0;
  if (x === Number.NEGATIVE_INFINITY) return 2;
  if (x < 0) return 2 - erfc(-x);
  if (x <= 1) return 1 - erfSmall(x);
  return erfcLarge(x);
}

/**
 * `sin(πx)`, taken from the distance to the nearest whole number.
 *
 * The reflection formula for Γ needs this, and needs it near the integers,
 * where sin(πx) approaches zero. Computing `sin(PI * x)` directly puts the
 * rounding of `PI * x` — absolute, and growing with x — right next to a zero:
 * at x = −4.00006 the answer came out 28582 ulp wrong. Subtracting the whole
 * part first is exact, and the sine then sees a small argument.
 */
function sinPi(x: number): number {
  const n = Math.floor(x + 0.5);
  const r = x - n;
  const s = sin(PI * r);
  return n % 2 === 0 ? s : -s;
}

/**
 * Lanczos coefficients, g = 7, n = 9 — the classic set.
 *
 * They give about fifteen correct digits of Γ, which is what makes a series of
 * nine terms competitive with a minimax polynomial twice the length.
 */
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

function lanczosSum(z: number): number {
  let a = LANCZOS[0] ?? 0;
  for (let i = 1; i < 9; i += 1) {
    a += (LANCZOS[i] ?? 0) / (z + i);
  }
  return a;
}

/** Is x a whole number in the range where Γ(x) = (x−1)! can be multiplied out? */
function isSmallWholeNumber(x: number): boolean {
  return x === Math.trunc(x) && x >= 1 && x <= 171;
}

/**
 * `lgamma(x)` — the natural logarithm of |Γ(x)|.
 *
 * ── What its accuracy actually is ────────────────────────────────────────────
 * Away from x = 1 and x = 2 it is within 3 ulp. AT those two points lgamma is
 * ZERO, and a relative bound there is not a statement about this code — no
 * method that sums terms of size 1 can be relatively accurate about their
 * cancelling to nothing. What holds everywhere is the ABSOLUTE error, measured
 * under 10⁻¹³, and both zeros come out exactly zero.
 */
export function lgamma(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (x === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  // The poles: every whole number at or below zero.
  if (x <= 0 && x === Math.trunc(x)) return Number.POSITIVE_INFINITY;
  if (x < 0.5) {
    return log(PI / Math.abs(sinPi(x))) - lgamma(1 - x);
  }
  const z = x - 1;
  const t = z + 7.5;
  return LOG_SQRT_2PI + (z + 0.5) * log(t) - t + log(lanczosSum(z));
}

/**
 * `gamma(x)` — Γ(x), the factorial extended to the reals.
 *
 * ── Why a whole number takes a different route ───────────────────────────────
 * Γ of a whole number is a factorial, and multiplying it out is both exact for
 * the first twenty-three and within 7 ulp for all 171 that fit in a double. The
 * general route cannot match that: it ends in an exponential, and `exp` turns
 * the absolute error of its argument into a relative error of its answer — so
 * the drift grows with log Γ(x) itself, reaching about 2000 ulp near x = 146.
 * The same amplification `pow` has, for the same reason.
 */
export function gamma(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (x === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  if (x === Number.NEGATIVE_INFINITY) return Number.NaN;
  // Every whole number at or below zero is a pole, with no value to give.
  if (x <= 0 && x === Math.trunc(x)) return Number.NaN;
  if (isSmallWholeNumber(x)) {
    let result = 1;
    for (let k = 2; k < x; k += 1) {
      result *= k;
    }
    return result;
  }
  if (x < 0.5) {
    return PI / (sinPi(x) * gamma(1 - x));
  }
  const z = x - 1;
  const t = z + 7.5;
  // One exponential rather than `t^(z+0.5) · e^(−t)`: that product overflows
  // near x = 150 on its first factor, while Γ(x) itself is still finite to 171.
  return SQRT_2PI * lanczosSum(z) * exp((z + 0.5) * log(t) - t);
}

/* ── The fifth wave: what was left ────────────────────────────────────────────
 *
 * Two conversions, and three functions that are each defined in terms of what
 * came before.
 */

/** 180/π and π/180. */
const DEGREES_PER_RADIAN = 57.29577951308232;
const RADIANS_PER_DEGREE = 0.017453292519943295;

/**
 * `degrees(x)` and `radians(x)` — one multiplication each, and exact in the
 * sense that matters: there is a single rounding, so all five agree trivially.
 *
 * They exist because every circular function here takes radians and says so.
 * A config holding an angle in degrees needs somewhere to put the conversion,
 * and a named function is better than the constant 57.29577951308232 appearing
 * in it by hand.
 */
export function degrees(x: number): number {
  return x * DEGREES_PER_RADIAN;
}

export function radians(x: number): number {
  return x * RADIANS_PER_DEGREE;
}

/**
 * `beta(a, b)` — the Euler beta function, Γ(a)Γ(b)/Γ(a+b).
 *
 * Taken directly from the gammas while they fit, because that is the accurate
 * route. Past a+b = 171 the numerator overflows although the answer is small —
 * beta SHRINKS as its arguments grow — so up there it goes through logarithms
 * instead, at the cost of the usual exponential amplification.
 */
export function beta(a: number, b: number): number {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
  if (a > 0 && b > 0 && a + b > 171) {
    return exp(lgamma(a) + lgamma(b) - lgamma(a + b));
  }
  return (gamma(a) * gamma(b)) / gamma(a + b);
}

/**
 * Asymptotic coefficients for digamma, ascending in 1/x²: −B₂ₖ/(2k).
 *
 * The series is asymptotic, not convergent — adding terms forever makes it
 * worse, not better. Eight is what the shift below can carry.
 */
const DIGAMMA_COEFF = [
  -1 / 12,
  1 / 120,
  -1 / 252,
  1 / 240,
  -1 / 132,
  691 / 32760,
  -1 / 12,
  3617 / 8160,
];

/**
 * Where the recurrence stops shifting.
 *
 * Ten, and larger is WORSE: each step of `ψ(x) = ψ(x+1) − 1/x` adds its own
 * rounding, so pushing to 14 or 20 to help the series costs more than it buys.
 * Measured against the exact value at whole numbers — ψ(n) = −γ + H(n−1) — ten
 * gives 3 ulp, fourteen gives 12.
 */
const DIGAMMA_SHIFT = 10;

/**
 * `digamma(x)` — ψ(x), the derivative of log Γ(x).
 *
 * Small arguments are lifted by the recurrence until the asymptotic series is
 * usable; negatives come back through the reflection ψ(1−x) − ψ(x) = π·cot(πx).
 */
export function digamma(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (x === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  // Every whole number at or below zero is a pole, as it is for Γ itself.
  if (x <= 0 && x === Math.trunc(x)) return Number.NaN;
  if (x < 0.5) {
    return digamma(1 - x) - PI / tan(PI * x);
  }
  let shifted = x;
  let correction = 0;
  while (shifted < DIGAMMA_SHIFT) {
    correction -= 1 / shifted;
    shifted += 1;
  }
  const f = 1 / (shifted * shifted);
  return correction + log(shifted) - 0.5 / shifted + f * horner(DIGAMMA_COEFF, f);
}

/** B₂ₖ/(2k)! for k = 1…7 — the Euler–Maclaurin tail for ζ. */
const ZETA_BERNOULLI = [
  1 / 12,
  -1 / 720,
  1 / 30240,
  -1 / 1209600,
  1 / 47900160,
  -691 / 1307674368000,
  1 / 74724249600,
];

/** How far the direct sum runs before Euler–Maclaurin takes over, and how many correction terms follow. */
const ZETA_TERMS = 12;
const ZETA_CORRECTIONS = 6;

/** ζ(s) for s > 1, by Euler–Maclaurin. */
function zetaSum(s: number): number {
  let total = 0;
  for (let n = 1; n < ZETA_TERMS; n += 1) {
    total += pow(n, -s);
  }
  const tail = pow(ZETA_TERMS, -s);
  total += tail / 2 + (ZETA_TERMS * tail) / (s - 1);
  // Then the Bernoulli corrections, each a rising factorial over a growing power.
  let rising = s;
  let power = tail / ZETA_TERMS;
  for (let k = 1; k <= ZETA_CORRECTIONS; k += 1) {
    total += (ZETA_BERNOULLI[k - 1] ?? 0) * rising * power;
    rising *= (s + 2 * k - 1) * (s + 2 * k);
    power /= ZETA_TERMS * ZETA_TERMS;
  }
  return total;
}

/**
 * `zeta(s)` — the Riemann zeta function, for real s.
 *
 * Above 1 the sum converges and Euler–Maclaurin makes twelve terms behave like
 * thousands. Below it the functional equation reflects the argument across
 * s = ½, which is why this needs Γ and sin and could not have been written
 * before them. ζ(1) is the pole; ζ(0) is −½, which the reflection cannot give
 * because it meets 0 · ∞ there.
 */
export function zeta(s: number): number {
  if (Number.isNaN(s)) return Number.NaN;
  if (s === 1) return Number.POSITIVE_INFINITY;
  if (s === 0) return -0.5;
  if (s > 1) return zetaSum(s);
  return pow(2, s) * pow(PI, s - 1) * sin((PI * s) / 2) * gamma(1 - s) * zetaSum(1 - s);
}
