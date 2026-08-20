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

/**
 * A deterministic value in [0, 1) from a pair of numbers — the `hash(n, salt)`
 * of the expression language.
 *
 * ── Why it exists ────────────────────────────────────────────────────────────
 * A config that wants "a different random coefficient for every beat N" has had
 * to write the shader trick: `sin(N * 12.9898) * 43758.5453`, minus its floor.
 * That works here — TDC computes its own `sin`, so all five implementations
 * agree on it — but it costs two transcendental calls per row, it is opaque in
 * a listing, and its distribution is an accident rather than a design.
 *
 * ── Why the key is built from BITS rather than from digits ───────────────────
 * The obvious spelling is to format the two numbers into the key string, the
 * way `seekableGen` formats its row index. That is safe for an integer index
 * and NOT safe here: `salt` is any double, and the shortest decimal form of a
 * double is not the same in every language — Java's `Double.toString` and
 * JavaScript's disagree about which digits to print. Building the key from the
 * IEEE-754 bit pattern instead removes the question: those 64 bits are pinned
 * by the standard, and formatting an integer as hex is exact everywhere.
 *
 * So the diffusion is cyrb128 and the stream is sfc32 — the two primitives the
 * rest of TDC already runs on, already covered by the shared PRNG vectors, and
 * already identical in five implementations. Nothing new to port but the bits.
 */
export function hashUnit(n: number, salt: number): number {
  // Both numbers go into the key, so a different salt is a different stream
  // over the same n — which is the whole point of the second argument.
  return seekableGen('hash', `${bitsHex(n)}|${bitsHex(salt)}`, 0)();
}

/**
 * A double as the 16 hex digits of its IEEE-754 image.
 *
 * `DataView` rather than arithmetic, because arithmetic on the exponent is
 * where a port quietly rounds. -0 and 0 keep their different patterns, which is
 * correct: they are different doubles, and a hash that conflated them would
 * disagree with a language that does not.
 */
const bitsView = new DataView(new ArrayBuffer(8));
function bitsHex(value: number): string {
  bitsView.setFloat64(0, value, false);
  const hi = bitsView.getUint32(0, false);
  const lo = bitsView.getUint32(4, false);
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

/**
 * Smooth one-dimensional value noise — the `noise(t, scale, salt)` of the
 * expression language.
 *
 * A drifting baseline is not three sine waves. Modulate them however you like
 * and a spectrum still shows three pure tones; this has a broad one, because
 * the value at each lattice point is independent and only the interpolation
 * between them is smooth.
 *
 * `scale` is the wavelength in rows: the value is drawn fresh every `scale`
 * rows and eased between. `salt` picks the series, exactly as in `hashUnit`.
 *
 * The easing is the classic smoothstep, `u * u * (3 - 2 * u)`, which is zero at
 * both ends and has zero slope there — so the curve has no corner where one
 * lattice cell meets the next. Interpolating with `a * (1 - u) + b * u` rather
 * than `a + (b - a) * u` for the same reason `lerp` does: it lands exactly on
 * the lattice value at u = 0 and u = 1, so a cell boundary is continuous to the
 * last bit rather than to within an ulp.
 *
 * A `scale` of zero divides by zero and the answer is NaN — IEEE's answer to a
 * question with no value, and the same one `sqrt(-1)` gives here.
 */
export function noiseUnit(t: number, scale: number, salt: number): number {
  const x = t / scale;
  const cell = Math.floor(x);
  const u = x - cell;
  const eased = u * u * (3 - 2 * u);
  const a = hashUnit(cell, salt);
  const b = hashUnit(cell + 1, salt);
  return a * (1 - eased) + b * eased;
}
