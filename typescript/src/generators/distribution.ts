/**
 * Statistical-distribution core — pure and engine-agnostic.
 *
 * A `number` generator can draw from a named distribution instead of a uniform
 * range (`<gen type="number" distribution="normal" mean="170" sd="10"/>`), so a
 * column looks like real data (heights, salaries, inter-event times, wealth).
 *
 * Design: `docs/superpowers/specs/2026-07-15-statistical-distributions-design.md`.
 *
 * Two invariants make this work with the streaming/disk engines:
 *   - **Fixed draws.** Each distribution consumes a FIXED number of uniform
 *     draws (`spec.draws`), so a row's value is seekable — computable from its
 *     index without generating the others. Only inverse-CDF / Box–Muller here;
 *     no rejection sampling (which would consume a variable number of draws).
 *   - **No dependency.** The math is hand-rolled and portable. `sampleDistribution`
 *     is covered by golden vectors — the exact-number contract every language
 *     port must reproduce from the same uniforms.
 *
 * `sampleDistribution` takes the uniforms as input; the ENGINE supplies them
 * (the render PRNG in memory, a seekable draw per row when streaming). Uniforms
 * MUST lie in the open interval (0, 1) — never exactly 0 or 1.
 */

import { betaIInv, gammaPInv } from './special.js';

interface Base {
  /** How many uniform draws in (0,1) `sampleDistribution` needs for this spec. */
  readonly draws: number;
  /** Output precision — digits after the decimal point (0 ⇒ integer). */
  readonly decimals: number;
  /** Optional inclusive clip of the sampled value. */
  readonly min?: number;
  readonly max?: number;
}

export type DistributionSpec = Base &
  (
    | { readonly name: 'normal'; readonly mean: number; readonly sd: number }
    | { readonly name: 'lognormal'; readonly meanlog: number; readonly sdlog: number }
    | { readonly name: 'exponential'; readonly rate: number }
    | { readonly name: 'pareto'; readonly alpha: number; readonly xmin: number }
    | { readonly name: 'weibull'; readonly shape: number; readonly scale: number }
    // Discrete: a precomputed cumulative table is sampled by binary search from
    // ONE uniform (still fixed-draw / seekable). `cdf[k]` = P(X ≤ k).
    | { readonly name: 'poisson'; readonly lambda: number; readonly cdf: readonly number[] }
    // `cum[k]` = P(rank ≤ k+1); sampling returns the 1-based rank.
    | {
        readonly name: 'zipf';
        readonly n: number;
        readonly s: number;
        readonly cum: readonly number[];
      }
    // Continuous, no closed-form inverse-CDF → inverted numerically (1 draw).
    | { readonly name: 'gamma'; readonly shape: number; readonly scale: number }
    | { readonly name: 'beta'; readonly alpha: number; readonly beta: number }
  );

export type DistributionName = DistributionSpec['name'];

/** Standard normal deviate via Box–Muller from two uniforms in (0,1). */
function boxMuller(u1: number, u2: number): number {
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Sample the distribution from `uniforms` (length ≥ `spec.draws`, each in
 * (0,1)). Returns the RAW value — clipping and rounding happen in
 * `formatSample`.
 */
export function sampleDistribution(spec: DistributionSpec, uniforms: readonly number[]): number {
  const [u1 = 0, u2 = 0] = uniforms;
  switch (spec.name) {
    case 'normal':
      return spec.mean + spec.sd * boxMuller(u1, u2);
    case 'lognormal':
      return Math.exp(spec.meanlog + spec.sdlog * boxMuller(u1, u2));
    case 'exponential':
      return -Math.log(u1) / spec.rate;
    case 'pareto':
      return spec.xmin * Math.pow(1 - u1, -1 / spec.alpha);
    case 'weibull':
      return spec.scale * Math.pow(-Math.log(u1), 1 / spec.shape);
    case 'poisson':
      return lowerBound(spec.cdf, u1); // smallest count k with P(X ≤ k) ≥ u
    case 'zipf':
      return lowerBound(spec.cum, u1) + 1; // ranks are 1-based
    case 'gamma':
      return spec.scale * gammaPInv(spec.shape, u1);
    case 'beta':
      return betaIInv(spec.alpha, spec.beta, u1);
  }
}

/** Smallest index `k` with `cum[k] ≥ u` (binary search); clamps to the last. */
function lowerBound(cum: readonly number[], u: number): number {
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((cum[mid] ?? 1) >= u) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Clip the raw sample to `[min, max]` (if set), then round to `decimals`. */
export function formatSample(x: number, spec: DistributionSpec): string {
  let v = x;
  if (spec.min !== undefined) v = Math.max(spec.min, v);
  if (spec.max !== undefined) v = Math.min(spec.max, v);
  return v.toFixed(spec.decimals);
}

/**
 * Parse and validate the distribution attributes of a `number` gen. Throws a
 * plain `Error` (callers add gen/source context). Only reads distribution
 * attributes — the incompatibility of `distribution` with range/percent/uniq is
 * enforced at the validation layer, which sees the whole gen.
 */
export function parseDistribution(attrs: Record<string, string | undefined>): DistributionSpec {
  const name = attrs['distribution'];
  const decimals = parseDecimals(attrs['decimals']);
  const min = parseOptNum(attrs['min'], 'min');
  const max = parseOptNum(attrs['max'], 'max');
  if (min !== undefined && max !== undefined && min > max) {
    throw new Error(`distribution: min (${String(min)}) must be ≤ max (${String(max)})`);
  }
  const clip = {
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
  };

  switch (name) {
    case 'normal':
      return {
        name,
        draws: 2,
        mean: requireNum(attrs, 'mean', name),
        sd: requirePositive(attrs, 'sd', name),
        decimals,
        ...clip,
      };
    case 'lognormal':
      return {
        name,
        draws: 2,
        meanlog: requireNum(attrs, 'meanlog', name),
        sdlog: requirePositive(attrs, 'sdlog', name),
        decimals,
        ...clip,
      };
    case 'exponential':
      return {
        name,
        draws: 1,
        rate: requirePositive(attrs, 'rate', name),
        decimals,
        ...clip,
      };
    case 'pareto':
      return {
        name,
        draws: 1,
        alpha: requirePositive(attrs, 'alpha', name),
        xmin: requirePositive(attrs, 'xmin', name),
        decimals,
        ...clip,
      };
    case 'weibull':
      return {
        name,
        draws: 1,
        shape: requirePositive(attrs, 'shape', name),
        scale: requirePositive(attrs, 'scale', name),
        decimals,
        ...clip,
      };
    case 'poisson': {
      const lambda = requirePositive(attrs, 'lambda', name);
      return { name, draws: 1, lambda, cdf: poissonCdf(lambda), decimals, ...clip };
    }
    case 'zipf': {
      const n = requireIntPositive(attrs, 'n', name);
      const s = requirePositive(attrs, 's', name);
      return { name, draws: 1, n, s, cum: zipfCumulative(n, s), decimals, ...clip };
    }
    case 'gamma':
      return {
        name,
        draws: 1,
        shape: requirePositive(attrs, 'shape', name),
        scale: requirePositive(attrs, 'scale', name),
        decimals,
        ...clip,
      };
    case 'beta':
      return {
        name,
        draws: 1,
        alpha: requirePositive(attrs, 'alpha', name),
        beta: requirePositive(attrs, 'beta', name),
        decimals,
        ...clip,
      };
    default:
      throw new Error(
        `distribution: unknown distribution "${String(name)}" — expected ` +
          'normal, lognormal, exponential, pareto, weibull, poisson, zipf, gamma, or beta',
      );
  }
}

/**
 * `e^-lambda` underflows to 0 above ~745, which would break the PMF recurrence.
 * Cap below that; for large means, `normal` with `mean=lambda, sd=sqrt(lambda)`
 * is the standard approximation anyway.
 */
const POISSON_MAX_LAMBDA = 700;

/** Guard against an absurd rank count exhausting memory. */
const ZIPF_MAX_N = 10_000_000;

/** Cumulative Poisson table: `cdf[k] = P(X ≤ k)`, extended until it reaches ~1. */
function poissonCdf(lambda: number): number[] {
  if (lambda > POISSON_MAX_LAMBDA) {
    throw new Error(
      `distribution "poisson": lambda ${String(lambda)} is too large (max ${String(
        POISSON_MAX_LAMBDA,
      )}); for large means use distribution="normal" mean="${String(lambda)}" sd="sqrt(lambda)".`,
    );
  }
  const cdf: number[] = [];
  let p = Math.exp(-lambda); // P(0)
  let cum = p;
  cdf.push(cum);
  const cap = lambda + 40 * Math.sqrt(lambda) + 100;
  for (let k = 1; cum < 1 - 1e-12 && k < cap; k++) {
    p = (p * lambda) / k;
    cum += p;
    cdf.push(Math.min(1, cum));
  }
  return cdf;
}

/** Cumulative bounded-Zipf table over ranks 1..n: `cum[k] = P(rank ≤ k+1)`. */
function zipfCumulative(n: number, s: number): number[] {
  if (n > ZIPF_MAX_N) {
    throw new Error(
      `distribution "zipf": n ${String(n)} is too large (max ${String(ZIPF_MAX_N)}).`,
    );
  }
  let sum = 0;
  const weights = new Array<number>(n);
  for (let k = 1; k <= n; k++) {
    const w = 1 / Math.pow(k, s);
    weights[k - 1] = w;
    sum += w;
  }
  const cum = new Array<number>(n);
  let c = 0;
  for (let k = 0; k < n; k++) {
    c += (weights[k] ?? 0) / sum;
    cum[k] = c;
  }
  cum[n - 1] = 1; // pin the last against fp drift so u near 1 lands on rank n
  return cum;
}

function parseDecimals(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`distribution: "decimals" must be a non-negative integer (got "${raw}")`);
  }
  return n;
}

function parseOptNum(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`distribution: "${label}" must be a number (got "${raw}")`);
  }
  return n;
}

function requireNum(attrs: Record<string, string | undefined>, key: string, dist: string): number {
  const raw = attrs[key];
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`distribution "${dist}": "${key}" is required and must be a number`);
  }
  return n;
}

function requirePositive(
  attrs: Record<string, string | undefined>,
  key: string,
  dist: string,
): number {
  const n = requireNum(attrs, key, dist);
  if (!(n > 0)) {
    throw new Error(
      `distribution "${dist}": "${key}" must be a positive number (got ${String(n)})`,
    );
  }
  return n;
}

function requireIntPositive(
  attrs: Record<string, string | undefined>,
  key: string,
  dist: string,
): number {
  const n = requireNum(attrs, key, dist);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `distribution "${dist}": "${key}" must be a positive integer (got ${String(n)})`,
    );
  }
  return n;
}

/**
 * Every attribute a distribution reads as a NUMBER — the ones that may instead
 * be an expression over the row's other columns.
 *
 * Kept as one list so "which parameters can follow a column" has a single
 * answer, rather than each caller remembering a different subset.
 */
export const DISTRIBUTION_PARAMS: readonly string[] = [
  'mean',
  'sd',
  'meanlog',
  'sdlog',
  'rate',
  'alpha',
  'xmin',
  'shape',
  'scale',
  'lambda',
  'beta',
  's',
  'n',
  'min',
  'max',
];

/** Digits, a point, a sign, an exponent — anything a plain number can be. */
const PLAIN_NUMBER = /^\s*[+-]?(\d+(?:\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/;

/**
 * The parameters this generator wrote as an EXPRESSION rather than a number.
 *
 * A bare number stays the degenerate case, so a config that never wanted this
 * pays nothing: the spec is parsed once, exactly as before, and only a config
 * that actually names a column takes the per-row path.
 *
 * This does NOT change how many uniforms a row consumes — `draws` depends only
 * on WHICH distribution, never on its parameters — so the property every engine
 * is built on (a row computable without its predecessors) is untouched. That is
 * the difference from `repeat=`, where a per-row count would have changed the
 * draw budget and was therefore refused; see `sequence/repeat.ts`.
 */
/**
 * How many uniforms a row of this distribution consumes, known from the NAME
 * alone — no parameters needed.
 *
 * Wanted by a row that cannot be drawn at all (a parameter read an empty cell),
 * which must still spend what a drawn row would spend. Otherwise blanking one
 * cell would slide every value after it, and a `parent=` filter would quietly
 * rewrite the rest of the column.
 */
export function distributionDraws(attrs: Record<string, string | undefined>): number {
  return TWO_DRAW.has((attrs['distribution'] ?? '').trim().toLowerCase()) ? 2 : 1;
}

/** The two distributions sampled from a PAIR of uniforms (Box-Muller). */
const TWO_DRAW = new Set(['normal', 'lognormal']);

export function expressionParams(attrs: Record<string, string | undefined>): readonly string[] {
  const found: string[] = [];
  for (const name of DISTRIBUTION_PARAMS) {
    const raw = attrs[name];
    if (raw === undefined || raw.trim() === '') continue;
    if (!PLAIN_NUMBER.test(raw)) found.push(name);
  }
  return found;
}
