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

/** Taylor coefficients for sin(r)/r − 1 over r², highest power first in use. */
const SIN_COEFF = [
  -1 / 6,
  1 / 120,
  -1 / 5040,
  1 / 362880,
  -1 / 39916800,
  1 / 6227020800,
  -1 / 1307674368000,
];

/** Taylor coefficients for cos(r) − 1 over r². */
const COS_COEFF = [
  -1 / 2,
  1 / 24,
  -1 / 720,
  1 / 40320,
  -1 / 3628800,
  1 / 479001600,
  -1 / 87178291200,
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

/** `2^n` for an integer n, by exact doubling — a power of two is exact in binary. */
function scaleByPowerOfTwo(value: number, n: number): number {
  let out = value;
  let k = n;
  // Stepping one power at a time keeps every intermediate a normal double for
  // the range `exp` allows, and each multiplication is exact.
  while (k > 0) {
    out *= 2;
    k -= 1;
  }
  while (k < 0) {
    out /= 2;
    k += 1;
  }
  return out;
}

/**
 * `exp(x)` — range-reduced to `2^k · e^r` with |r| ≤ ln2/2, then Taylor.
 *
 * Thirteen terms take |r| ≤ 0.347 well past double precision; the series is
 * evaluated forward because each term is the previous one times `r/i`, which
 * costs one multiply and one divide and needs no coefficient table.
 */
export function exp(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (x > EXP_OVERFLOW) return Number.POSITIVE_INFINITY;
  if (x < EXP_UNDERFLOW) return 0;
  const k = Math.trunc(x / LN2 + (x >= 0 ? 0.5 : -0.5));
  const r = x - k * LN2_HI - k * LN2_LO;
  let term = 1;
  let sum = 1;
  for (let i = 1; i <= 13; i += 1) {
    term = (term * r) / i;
    sum += term;
  }
  return scaleByPowerOfTwo(sum, k);
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
  const s2 = s * s;
  let sum = 0;
  for (let i = 25; i >= 1; i -= 2) {
    sum = sum * s2 + 1 / i;
  }
  return 2 * s * sum + e * LN2_HI + e * LN2_LO;
}

/** `log10(x)`, as `log(x) / ln 10`. */
export function log10(x: number): number {
  return log(x) / 2.302585092994046;
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
export function pow(x: number, y: number): number {
  if (Number.isNaN(y)) return Number.NaN;
  if (y === 0) return 1;
  if (Number.isNaN(x)) return Number.NaN;
  if (Number.isInteger(y) && Math.abs(y) <= 1024) {
    let result = 1;
    let base = y < 0 ? 1 / x : x;
    let n = Math.abs(y);
    while (n > 0) {
      if (n % 2 === 1) result *= base;
      base *= base;
      n = Math.trunc(n / 2);
    }
    return result;
  }
  // A negative base with a fractional exponent has no real answer, and saying
  // so is better than returning whatever the general route would produce.
  if (x < 0) return Number.NaN;
  if (x === 0) return y > 0 ? 0 : Number.POSITIVE_INFINITY;
  return exp(y * log(x));
}
