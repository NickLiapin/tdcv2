/**
 * Seeded pseudo-random number generator.
 *
 * Implementation: cyrb128 (string → 128-bit hash split into four 32-bit
 * uints) feeding sfc32 (small fast counter, 4 × 32-bit state → one float
 * per call). Both are public-domain PRNGs from the well-known
 * bryc/code reference collection; the exact byte-layout is ported
 * verbatim from the 2022-2024 TDC prototype (src/generator/Generator.ts)
 * so that TDC v1.x continues to produce byte-identical output for any
 * existing DSL file + seed pair.
 *
 * CRITICAL — bit-identical determinism across language implementations
 * depends on this module. See docs/vision/16-portability.md. Any change
 * here must be mirrored in the Python and Java implementations with
 * matching behaviour verified by the shared fixture test suite.
 *
 * Both the hashing and the generator use `Math.imul`, `>>> 0`, and
 * `| 0` to force 32-bit unsigned/signed arithmetic in JavaScript's
 * otherwise-float-only number type. Ports must carefully mirror these
 * operations in their own language's integer semantics.
 */

/**
 * Derive four 32-bit unsigned integers from a seed string.
 *
 * Exported for reuse (e.g. re-seeding) and for cross-language golden
 * value tests; most callers want `createPrng` instead.
 */
export function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

/**
 * Build an sfc32 generator from four 32-bit unsigned integer state
 * words. Each call returns a float in [0, 1).
 */
export function sfc32(a: number, b: number, c: number, d: number): () => number {
  return (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/**
 * Create a deterministic pseudo-random float generator from a seed
 * string. Returns a zero-argument function; each invocation produces
 * the next float in [0, 1).
 *
 * The same seed always produces the same sequence of floats, across
 * all TDC language implementations (TypeScript, Python, Java).
 */
export function createPrng(seed: string): () => number {
  const [a, b, c, d] = cyrb128(seed);
  return sfc32(a, b, c, d);
}
