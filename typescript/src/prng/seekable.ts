/**
 * Seekable (counter-based) PRNG for the streaming engine.
 *
 * The normal `createPrng` is sequential — you get value N only by drawing the
 * N−1 before it. Engine 2 needs `value(i)` for an arbitrary row `i` in O(1),
 * so we derive the state by HASHING `(seed, streamId, index)` and running the
 * same sfc32 the rest of TDC uses. Each `streamId` is an independent stream
 * (one per sequence/field), and each `index` is an independent draw — so a
 * field's value for row `i` is computable without touching any other row.
 *
 * Determinism is byte-identical to the sequential engine's building blocks
 * (cyrb128 → sfc32), so Python/Java ports reproduce it — provided they format
 * the key string identically: `${seed}|${streamId}|${index}` with `index` as
 * a plain decimal integer.
 */

import { cyrb128, sfc32 } from './prng.js';

/**
 * An independent generator for row `index` of stream `streamId`. Call it as
 * many times as a single value needs (e.g. a regex draws several numbers) —
 * the sequence is deterministic per `(seed, streamId, index)`.
 */
export function seekableGen(seed: string, streamId: string, index: number): () => number {
  const [a, b, c, d] = cyrb128(`${seed}|${streamId}|${String(index)}`);
  return sfc32(a, b, c, d);
}

/** One float in [0, 1) for row `index` of stream `streamId`. */
export function seekableFloat(seed: string, streamId: string, index: number): number {
  return seekableGen(seed, streamId, index)();
}

/** One integer in [0, n) for row `index` of stream `streamId`. */
export function seekableInt(seed: string, streamId: string, index: number, n: number): number {
  if (n <= 1) return 0;
  return Math.floor(seekableFloat(seed, streamId, index) * n);
}

/**
 * Half a 32-bit ULP. sfc32 emits `k/2^32 ∈ [0, 1−2^−32]`; nudging by this maps a
 * draw into the OPEN interval (0,1), so inverse-CDF sampling (`ln`, `pow`) never
 * hits an infinity at `u=0` or `u=1`. The perturbation (~1e-10) is statistically
 * negligible.
 */
const HALF_ULP = 0.5 / 4294967296;

/** Map a raw [0,1) draw (or any value) into the open interval (0,1). */
export function openUnit(u: number): number {
  return Math.min(1 - HALF_ULP, Math.max(HALF_ULP, u + HALF_ULP));
}

/**
 * `count` independent uniforms in the OPEN interval (0,1) for row `index` of
 * stream `streamId` — exactly the draws a fixed-draw distribution sampler needs
 * (see `generators/distribution.ts`). Deterministic and seekable per row.
 */
export function seekableUniforms(
  seed: string,
  streamId: string,
  index: number,
  count: number,
): number[] {
  const gen = seekableGen(seed, streamId, index);
  const out = new Array<number>(count);
  for (let k = 0; k < count; k++) out[k] = openUnit(gen());
  return out;
}
