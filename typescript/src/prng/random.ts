/**
 * Convenience utilities layered on top of a raw PRNG function.
 *
 * Kept separate from `prng.ts` so that the core generator stays
 * auditable and minimal; these helpers operate purely via a supplied
 * `() => number` and have no state of their own.
 */

/**
 * Integer in `[min, max)` (half-open), uniform over the integer range
 * assuming the underlying prng is uniform over `[0, 1)`.
 *
 * `min` and `max` MUST satisfy `min < max`. No bounds check is
 * performed; callers provide validated inputs.
 */
export function randomInt(prng: () => number, min: number, max: number): number {
  return Math.floor(prng() * (max - min) + min);
}

/**
 * Pick a uniformly random element from a non-empty array.
 *
 * The array MUST be non-empty; no bounds check is performed.
 */
export function randomPick<T>(prng: () => number, arr: readonly T[]): T {
  const index = Math.floor(prng() * arr.length);
  // Non-null assertion is safe: we just derived a valid in-bounds index.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return arr[index]!;
}

/**
 * Fisher-Yates shuffle, returning a new array. Does not mutate the
 * input. The order is deterministic given the prng state.
 *
 * This is the exact shuffle used by the 2022-2024 prototype — iterate
 * from the end, swap with a random earlier (or equal) index. Any port
 * must mirror the iteration direction and swap discipline to produce
 * bit-identical results from the same seed + input.
 */
export function shuffle<T>(prng: () => number, arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(prng() * (i + 1));
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
