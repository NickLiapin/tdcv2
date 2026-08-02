/**
 * Numerical special functions for exact, seekable gamma/beta sampling.
 *
 * gamma and beta have no closed-form inverse CDF, but their CDFs — the
 * regularized lower incomplete gamma `P(a,x)` and regularized incomplete beta
 * `I_x(a,b)` — are computable, and inverting them numerically (bisection) gives
 * an EXACT inverse-CDF sampler that consumes exactly ONE uniform. That keeps
 * gamma/beta deterministic and seekable like every other distribution — no
 * rejection sampling (variable draws), no approximation.
 *
 * Algorithms follow the standard series / continued-fraction forms (Numerical
 * Recipes). Hand-rolled — no dependency.
 */

const LANCZOS_G = 7;
const LANCZOS_C = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

/** Natural log of the gamma function (Lanczos approximation). */
export function lgamma(z: number): number {
  if (z < 0.5) {
    // Reflection formula for the left half-plane.
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  }
  const zz = z - 1;
  let x = LANCZOS_C[0] ?? 0;
  for (let i = 1; i < LANCZOS_G + 2; i++) x += (LANCZOS_C[i] ?? 0) / (zz + i);
  const t = zz + LANCZOS_G + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
}

const MAX_ITER = 300;
const EPS = 1e-15;
const FPMIN = 1e-300;

/** Regularized lower incomplete gamma `P(a,x)` — the CDF of gamma(a, 1) at x. */
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  if (x < a + 1) return gammaSeries(a, x);
  return 1 - gammaContinuedFraction(a, x);
}

function gammaSeries(a: number, x: number): number {
  const gln = lgamma(a);
  let ap = a;
  let sum = 1 / a;
  let del = sum;
  for (let n = 0; n < MAX_ITER; n++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * EPS) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - gln);
}

/** Returns `Q(a,x) = 1 - P(a,x)` via its continued fraction. */
function gammaContinuedFraction(a: number, x: number): number {
  const gln = lgamma(a);
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < MAX_ITER; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}

/** Regularized incomplete beta `I_x(a,b)` — the CDF of beta(a,b) at x. */
export function betaI(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) return (bt * betaContinuedFraction(a, b, x)) / a;
  return 1 - (bt * betaContinuedFraction(b, a, 1 - x)) / b;
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m < MAX_ITER; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

const BISECTION_ITER = 100; // 2^-100 ≪ double precision

/** Inverse of `gammaP(a, ·)`: the x ≥ 0 with `P(a,x) = u`, for u in (0,1). */
export function gammaPInv(a: number, u: number): number {
  let hi = 1;
  while (gammaP(a, hi) < u && hi < 1e300) hi *= 2;
  let lo = 0;
  for (let i = 0; i < BISECTION_ITER; i++) {
    const mid = (lo + hi) / 2;
    if (gammaP(a, mid) < u) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Inverse of `betaI(·, a, b)`: the x in (0,1) with `I_x(a,b) = u`. */
export function betaIInv(a: number, b: number, u: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < BISECTION_ITER; i++) {
    const mid = (lo + hi) / 2;
    if (betaI(mid, a, b) < u) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
